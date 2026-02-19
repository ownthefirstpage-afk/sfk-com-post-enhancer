// Railway Enhancer Service - SFK Post Enhancer (POLLING VERSION)
// Removed callback dependency - polls Kei.ai task status instead

const express = require('express');
const axios = require('axios');
const sharp = require('sharp');

const app = express();
app.use(express.json());

// ── CONFIG ────────────────────────────────────────────────────────
const WP_URL = 'https://sprayfoamkings.com';
const WP_USER = 'molt1982';
const WP_PASS = process.env.WP_APP_PASSWORD || 'NPeI nbJX kC9d 51tJ 271M JFnf';
const WP_AUTH = 'Basic ' + Buffer.from(`${WP_USER}:${WP_PASS}`).toString('base64');

const KIE_API_KEY = process.env.KIE_API_KEY;
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
const YT_CHANNEL_ID = process.env.YT_CHANNEL_ID || '';
const BOT_TOKEN = process.env.BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const AUTH_TOKEN = process.env.RAILWAY_AUTH_TOKEN || 'moltbot-railway-secret';

// Toronto geo coords
const GEO = { lat: 43.6532, lng: -79.3832 };

// ── AUTH MIDDLEWARE ───────────────────────────────────────────────
app.use((req, res, next) => {
  if (req.path === '/health') return next();
  const key = req.headers['x-moltbot-key'];
  if (key !== AUTH_TOKEN) return res.status(401).json({ error: 'unauthorized' });
  next();
});

// ── TELEGRAM ──────────────────────────────────────────────────────
async function tgSend(msg) {
  if (!BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    chat_id: TELEGRAM_CHAT_ID,
    text: msg
  }).catch(() => {});
}

// ── STEP 1: GENERATE IMAGE VIA KIE.AI (WITH POLLING) ───────────────
async function generateImage(imagePrompt) {
  console.log('Generating image:', imagePrompt.substring(0, 80));

  // Create task without callback
  const createRes = await axios.post('https://api.kie.ai/api/v1/jobs/createTask', {
    model: 'nano-banana-pro',
    input: {
      prompt: imagePrompt,
      aspect_ratio: '16:9',
      resolution: '1K',
      output_format: 'jpg'
    }
  }, {
    headers: {
      'Authorization': `Bearer ${KIE_API_KEY}`,
      'Content-Type': 'application/json'
    }
  });

  const taskId = createRes.data?.data?.taskId;
  if (!taskId) throw new Error(`kie.ai: no taskId. Response: ${JSON.stringify(createRes.data)}`);
  console.log('kie.ai task created:', taskId);

  // Poll for completion
  const maxAttempts = 60; // 60 * 2 seconds = 2 minutes
  let attempts = 0;

  while (attempts < maxAttempts) {
    await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2 seconds between polls
    attempts++;

    try {
      const statusRes = await axios.get(`https://api.kie.ai/api/v1/jobs/queryTask?taskId=${taskId}`, {
        headers: {
          'Authorization': `Bearer ${KIE_API_KEY}`
        }
      });

      const status = statusRes.data?.data;
      console.log(`Poll ${attempts}: task status =`, status?.state);

      if (status?.state === 'success') {
        const imgUrl = status?.resultUrls?.[0];
        if (imgUrl) {
          console.log('Image generated successfully');
          return imgUrl;
        }
      } else if (status?.state === 'fail') {
        throw new Error(`kie.ai generation failed: ${status?.failMsg || 'unknown'}`);
      }
    } catch(e) {
      if (e.message.includes('generation failed')) throw e;
      console.error(`Poll attempt ${attempts} error:`, e.message);
    }
  }

  throw new Error('kie.ai: timeout after polling for 120 seconds');
}

// ── STEP 2: DOWNLOAD + PROCESS IMAGE ─────────────────────────────
async function downloadAndProcess(imgUrl, title) {
  console.log('Downloading image:', imgUrl);
  const response = await axios.get(imgUrl, { responseType: 'arraybuffer' });
  const buffer = Buffer.from(response.data);

  const processed = await sharp(buffer)
    .jpeg({ quality: 85 })
    .toBuffer();

  const filename = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .substring(0, 60)
    + '-sprayfoam.jpg';

  return { buffer: processed, filename };
}

// ── STEP 3: UPLOAD IMAGE TO WORDPRESS ────────────────────────────
async function uploadImageToWP(buffer, filename, title, altText) {
  console.log('Uploading image to WordPress:', filename);

  const uploadRes = await axios.post(`${WP_URL}/wp-json/wp/v2/media`, buffer, {
    headers: {
      'Authorization': WP_AUTH,
      'Content-Type': 'image/jpeg',
      'Content-Disposition': `attachment; filename="${filename}"`,
    }
  });

  const mediaId = uploadRes.data?.id;
  if (!mediaId) throw new Error('WordPress media upload failed');

  await axios.post(`${WP_URL}/wp-json/wp/v2/media/${mediaId}`, {
    alt_text: altText,
    caption: `${title} - Spray Foam Kings`,
    description: `Professional spray foam insulation and fireproofing services in Ontario. ${altText}`
  }, {
    headers: { 'Authorization': WP_AUTH, 'Content-Type': 'application/json' }
  });

  console.log('Image uploaded, media ID:', mediaId);
  return mediaId;
}

// ── STEP 4: FIND YOUTUBE VIDEO ────────────────────────────────────
async function findYouTubeVideo(topic) {
  if (!YOUTUBE_API_KEY || !YT_CHANNEL_ID) return null;
  try {
    const res = await axios.get('https://www.googleapis.com/youtube/v3/search', {
      params: {
        key: YOUTUBE_API_KEY,
        channelId: YT_CHANNEL_ID,
        q: topic,
        type: 'video',
        part: 'snippet',
        maxResults: 1,
        order: 'relevance'
      }
    });
    const video = res.data?.items?.[0];
    if (!video) return null;
    return { id: video.id?.videoId, title: video.snippet?.title };
  } catch(e) {
    console.error('YouTube error:', e.message);
    return null;
  }
}

// ── STEP 5: UPDATE WORDPRESS POST ────────────────────────────────
async function updateWPPost(postId, mediaId, video, focusKeyword, metaDescription, postTitle) {
  console.log('Updating WordPress post:', postId);

  const getRes = await axios.get(`${WP_URL}/wp-json/wp/v2/posts/${postId}?context=edit`, {
    headers: { 'Authorization': WP_AUTH }
  });
  let currentContent = getRes.data?.content?.raw || '';

  if (video) {
    currentContent += `\n\n<div style="margin:30px 0;"><iframe width="560" height="315" src="https://www.youtube.com/embed/${video.id}" title="${video.title}" frameborder="0" allowfullscreen style="max-width:100%;"></iframe><p><em>Watch: ${video.title}</em></p></div>`;
  }

  await axios.post(`${WP_URL}/wp-json/wp/v2/posts/${postId}`, {
    content: currentContent,
    featured_media: mediaId,
    meta: {
      rank_math_focus_keyword: focusKeyword,
      rank_math_description: metaDescription,
      rank_math_title: `${postTitle} | Spray Foam Kings`,
      geo_latitude: String(GEO.lat),
      geo_longitude: String(GEO.lng),
      geo_address: 'Toronto, Ontario, Canada'
    }
  }, {
    headers: { 'Authorization': WP_AUTH, 'Content-Type': 'application/json' }
  });

  console.log('WordPress post updated');
}

// ── MAIN ENHANCE ROUTE ────────────────────────────────────────────
app.post('/enhance', async (req, res) => {
  res.json({ success: true, message: 'Enhancement started' });

  const { post_id, post_url, title, image_prompt, focus_keyword, meta_description, topic } = req.body;
  console.log(`\n=== ENHANCING SFK: ${title} ===`);

  try {
    await tgSend(`🎨 SFK Enhancing: "${title}"\n⏳ Getting image + YouTube...`);

    const [imgUrl, video] = await Promise.all([
      generateImage(image_prompt || `Professional spray foam insulation contractor in Ontario applying foam insulation, safety equipment, high quality work, realistic photo`),
      findYouTubeVideo(topic || title)
    ]);

    const { buffer, filename } = await downloadAndProcess(imgUrl, title);
    const altText = `${title} - Spray Foam Kings Ontario`;
    const mediaId = await uploadImageToWP(buffer, filename, title, altText);

    await updateWPPost(post_id, mediaId, video, focus_keyword, meta_description, title);

    let msg = `✅ SFK Post Enhanced!\n\n📄 ${title}\n🔗 ${post_url}\n\n`;
    msg += `🖼️ Featured image: uploaded\n`;
    msg += video ? `🎬 YouTube: "${video.title}" embedded\n` : `🎬 YouTube: no video found\n`;
    msg += `📊 RankMath: updated\n📍 Geo: Ontario tagged\n`;
    msg += `\n🕐 ${new Date().toLocaleString('en-CA', { timeZone: 'America/Toronto' })}`;

    await tgSend(msg);
    console.log('=== SFK ENHANCEMENT COMPLETE ===\n');

  } catch(e) {
    console.error('Enhancement error:', e.message);
    await tgSend(`❌ SFK Enhancement failed for "${title}"\nError: ${e.message}\n\nPost is live but without image/YouTube.`);
  }
});

// ── HEALTH ────────────────────────────────────────────────────────
app.get('/health', (_, res) => res.json({ ok: true, service: 'SFK Post Enhancer (Polling)', version: '2.0.0' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Railway SFK Enhancer v2 (polling) running on port ${PORT}`));
