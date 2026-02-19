// Railway Enhancer Service - SFK Post Enhancer
// Triggered by seo-blast-worker-sfk after publish
// Does: kie.ai image (callback) → WP featured image → YouTube embed → RankMath fix → Telegram notify

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
const RAILWAY_URL = process.env.RAILWAY_URL || 'https://sfk-com-post-enhancer-production.up.railway.app';

// Toronto geo coords
const GEO = { lat: 43.6532, lng: -79.3832 };

// In-memory pending kie.ai jobs
const pendingJobs = new Map();

// ── AUTH MIDDLEWARE ───────────────────────────────────────────────
app.use((req, res, next) => {
  if (req.path === '/health' || req.path === '/kie-callback') return next();
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

// ── KIE.AI CALLBACK ENDPOINT ─────────────────────────────────────
app.post('/kie-callback', (req, res) => {
  res.json({ ok: true });
  const data = req.body?.data;
  const taskId = data?.taskId;
  const state = data?.state;
  console.log('kie.ai callback received:', taskId, state);

  const job = pendingJobs.get(taskId);
  if (!job) return;

  if (state === 'success') {
    try {
      const result = JSON.parse(data.resultJson || '{}');
      const imgUrl = result?.resultUrls?.[0];
      if (imgUrl) {
        pendingJobs.delete(taskId);
        job.resolve(imgUrl);
      } else {
        pendingJobs.delete(taskId);
        job.reject(new Error('kie.ai: no image URL in callback'));
      }
    } catch(e) {
      pendingJobs.delete(taskId);
      job.reject(new Error('kie.ai: failed to parse resultJson'));
    }
  } else if (state === 'fail') {
    pendingJobs.delete(taskId);
    job.reject(new Error(`kie.ai: generation failed - ${data?.failMsg || 'unknown'}`));
  }
});

// ── STEP 1: GENERATE IMAGE VIA KIE.AI ────────────────────────────
async function generateImage(imagePrompt, aspectRatio = '16:9') {
  console.log('Generating image:', imagePrompt.substring(0, 80));

  const createRes = await axios.post('https://api.kie.ai/api/v1/jobs/createTask', {
    model: 'nano-banana-pro',
    callBackUrl: `${RAILWAY_URL}/kie-callback`,
    input: {
      prompt: imagePrompt,
      aspect_ratio: aspectRatio,
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

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingJobs.delete(taskId);
      reject(new Error('kie.ai: timeout after 120 seconds'));
    }, 120000);

    pendingJobs.set(taskId, {
      resolve: (url) => { clearTimeout(timeout); resolve(url); },
      reject: (err) => { clearTimeout(timeout); reject(err); }
    });
  });
}

// ── NEW: GENERATE IMAGE ENDPOINT (FOR SOCIAL POSTS) ───────────────
app.post('/generate-image', async (req, res) => {
  const { prompt, topic } = req.body;
  
  if (!prompt && !topic) {
    return res.status(400).json({ error: 'prompt or topic required' });
  }
  
  const imagePrompt = prompt || `Professional spray foam insulation contractor in Toronto applying foam insulation about ${topic}, safety equipment, high quality work, realistic photo, modern, clean`;
  
  console.log(`\n=== GENERATING IMAGE FOR SOCIAL POST ===`);
  console.log('Prompt:', imagePrompt.substring(0, 100));
  
  try {
    const imageUrl = await generateImage(imagePrompt, '1:1'); // Square for social media
    
    console.log('✅ Image generated:', imageUrl);
    
    res.json({
      success: true,
      url: imageUrl,
      prompt: imagePrompt
    });
    
  } catch (error) {
    console.error('Image generation failed:', error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

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
app.get('/health', (_, res) => res.json({ ok: true, service: 'SFK Post Enhancer', version: '1.1.0' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Railway SFK Enhancer v1.1 running on port ${PORT}`));
