import * as line from '@line/bot-sdk'
import express from 'express'
import * as dotenv from 'dotenv';
dotenv.config();
import { createClient } from '@supabase/supabase-js';
import { GoogleGenAI } from '@google/genai';

// create LINE SDK config from env variables
const config = {
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

// create LINE SDK client
const client = line.LineBotClient.fromChannelAccessToken({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN
});

// create Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  // process.env.SUPABASE_KEY,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
});

// create Express app
// about Express itself: https://expressjs.com/
const app = express();

// GET Method test
app.get('/', (req, res) => {
  res.send('hello world, Chavalit Koweerawong');
});


// register a webhook handler with middleware
// about the middleware, please refer to doc
app.post('/callback', line.middleware(config), (req, res) => {
  Promise
    .all(req.body.events.map(handleEvent))
    .then((result) => res.json(result))
    .catch((err) => {
      console.error(err);
      res.status(500).end();
    });
});

// event handler
function handleEvent2(event) {
  if (event.type !== 'message' || event.message.type !== 'text') {
    // ignore non-text-message event
    return Promise.resolve(null);
  }

  // create an echoing text message
  const echo = { type: 'text', text: event.message.text };
  

  // use reply API
  return client.replyMessage({
    replyToken: event.replyToken,
    messages: [echo],
  });
}

// 1. สร้าง Blob Client สำหรับดึงข้อมูลไฟล์โดยเฉพาะ (ของ v9+)
const lineBlobClient = new line.messagingApi.MessagingApiBlobClient({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || ''
});

const downloadLineContent = async (messageId) => {
  const stream = await lineBlobClient.getMessageContent(messageId);
  const chunks = [];
  
  // รองรับทั้งแบบ Blob (มี arrayBuffer) และแบบ Stream
  if (stream.arrayBuffer) {
    const arrayBuffer = await stream.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    return {
      inlineData: {
        data: buffer.toString('base64'),
        mimeType: stream.type || 'image/jpeg'
      },
      buffer: buffer
    };
  } else {
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);
    return {
      inlineData: {
        data: buffer.toString('base64'),
        mimeType: 'image/jpeg'
      },
      buffer: buffer
    };
  }
};

async function handleImage(messageId) {
  try {
    // ดาวน์โหลดรูปภาพจาก LINE และดึงมาทั้ง Base64 และ Buffer
    const imageContent = await downloadLineContent(messageId);
    
    // const fileName = `images/${event.message.id}.jpg`;
    
    const fileName = `${messageId}.jpg`;

    // 4. อัปโหลดเข้า Supabaseตามปกติ
    const { data: uploadData, error: uploadError } = await supabase
      .storage
      .from('uploads')
      .upload(`bot-uploads/${fileName}`, imageContent.buffer, {
        contentType: 'image/jpeg',
        upsert: true
      });

    if (uploadError) throw new Error(uploadError.message);

    // 5. ดึง Public URL กลับออกไป
    const { data: publicUrlData } = supabase
      .storage
      .from('uploads')
      .getPublicUrl(`bot-uploads/${fileName}`);

    return publicUrlData.publicUrl;

  } catch (error) {
    console.error('Error ในการดึงรูปภาพด้วย SDK v9:', error);
    return null;
  }
}

// 4. ฟังก์ชันหลักในการจัดการ Event และบันทึกข้อมูล
async function handleEvent(event) {
  if (event.type === "message" && event.message.type === "image") {
    return handleImage(event.message.id);
  }


  // รองรับเฉพาะ Event ประเภทข้อความ (Message Event) เท่านั้น
  if (event.type !== 'message') {
    return null;
  }

  const userId = event.source.userId || 'unknown';
  const replyToken = event.replyToken || '';
  
  // ดึงข้อมูลพื้นฐานจาก Message Object ของ LINE
  const messageId = event.message.id;
  const messageType = event.message.type; // text, image, sticker, video, etc.
  
  let content = null;
  let botReplyText = '';

  // ตรวจสอบเงื่อนไขตามประเภทข้อความ
  if (event.message.type === 'text') {
    content = event.message.text;
    botReplyText = event.message.text; // ข้อความที่จะตอบกลับ (Echo)
  } else {
    // หากเป็นประเภทอื่น เช่น image, sticker, video
    content = `[Received ${messageType} message]`;
    botReplyText = `ได้รับข้อความประเภท ${messageType} แล้วครับ`;
  }

  

  try {
    // ส่งข้อความของผู้ใช้ไปให้ Gemini คิดคำตอบ (ใช้โมเดลล่าสุด gemini-2.5-flash)
    const geminiResponse = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: content,
    });

    botReplyText = geminiResponse.text || 'ขออภัยครับ ระบบไม่สามารถสร้างคำตอบได้';
  
    // บันทึกข้อมูลลงตาราง messages ใน Supabase (บันทึกคู่ทั้งคำถามและคำตอบที่เตรียมไว้)
    const { error } = await supabase
      .from('messages')
      .insert([
        {
          user_id: userId,
          message_id: messageId,
          type: messageType,
          content: content,
          reply_token: replyToken,
          reply_content: botReplyText
        }
      ]);

    if (error) {
      console.error('Supabase Insert Error:', error.message);
    }

    // ตอบกลับข้อความไปยังผู้ใช้ใน LINE
    return await client.replyMessage({
      replyToken: replyToken,
      messages: [
        {
          type: 'text',
          text: botReplyText,
        },
      ],
    });

  } catch (error) {
    console.error('เกิดข้อผิดพลาดในการประมวลผลระบบ:', error);
  }
}



// listen on port
const port = process.env.PORT || 3099;
app.listen(port, () => {
  console.log(`listening on ${port}`);
});