const express = require('express');
const { chromium } = require('playwright');
const path = require('path');

const app = express();
app.use(express.json());

const USER_DATA_DIR = path.join(__dirname, '.browser-data');
let browserContext = null;

async function getBrowserContext() {
  if (browserContext) return browserContext;

  // Render par hamesha headless: true rakhna zaroori hai
  browserContext = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: true,
    viewport: { width: 1280, height: 720 },
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--disable-gpu'
    ],
  });
  return browserContext;
}

async function closeBrowser() {
  if (browserContext) {
    await browserContext.close().catch(() => {});
    browserContext = null;
  }
}

// Serve the frontend
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Check auth status
app.get('/api/check-auth', async (_req, res) => {
  try {
    const ctx = await getBrowserContext();
    const page = await ctx.newPage();

    const authPromise = page.waitForResponse(
      (r) => r.url().includes('/api/v1/auth'),
      { timeout: 15000 }
    );

    await page.goto('https://www.diskwala.com/dashboard', {
      waitUntil: 'domcontentloaded',
      timeout: 15000,
    });

    let loggedIn = false;
    try {
      const authResp = await authPromise;
      loggedIn = authResp.status() === 200;
    } catch {
      loggedIn = false;
    }

    await page.close();
    res.json({ loggedIn });
  } catch (err) {
    res.json({ loggedIn: false, error: err.message });
  }
});

// Get download link
app.post('/api/get-download', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });

  const match = url.match(/\/app\/([a-f0-9]+)/);
  if (!match) {
    return res.status(400).json({ error: 'Invalid Diskwala URL.' });
  }

  const fileId = match[1];

  try {
    const ctx = await getBrowserContext();
    const page = await ctx.newPage();

    let capturedAppicrypt = '';
    let capturedTs = '';

    page.on('request', (request) => {
      const h = request.headers();
      if (h['appicrypt'] && request.url().includes('ddudapidd.diskwala.com')) {
        capturedAppicrypt = h['appicrypt'];
        capturedTs = h['appicrypt-ts'] || '';
      }
    });

    const tempInfoPromise = page.waitForResponse(
      (r) => r.url().includes('/api/v1/file/temp_info'),
      { timeout: 20000 }
    );

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });

    const tempInfoResp = await tempInfoPromise;
    const tempInfo = await tempInfoResp.json().catch(() => null);

    await page.waitForTimeout(1000);

    const cookies = await ctx.cookies('https://ddudapidd.diskwala.com');
    const cookieStr = cookies.map((c) => `${c.name}=${c.value}`).join('; ');

    const signResponse = await page.request.post(
      'https://ddudapidd.diskwala.com/api/v1/file/sign',
      {
        data: { id: fileId },
        headers: {
          'Content-Type': 'application/json',
          Appicrypt: capturedAppicrypt,
          'Appicrypt-ts': capturedTs,
          Origin: 'https://www.diskwala.com',
          Referer: 'https://www.diskwala.com/',
          Cookie: cookieStr,
        },
      }
    );

    const signStatus = signResponse.status();
    const signBody = await signResponse.json().catch(() => null);

    await page.close();

    if (signStatus === 200 && signBody) {
      return res.json({
        success: true,
        fileId,
        fileInfo: tempInfo?.fileInfo || null,
        signData: signBody,
      });
    }

    res.json({
      success: false,
      error: `Sign API returned ${signStatus}`,
      details: signBody,
      fileInfo: tempInfo?.fileInfo || null,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Proxy download
app.get('/api/download', async (req, res) => {
  const downloadUrl = req.query.url;
  const fileName = req.query.name || 'download.mp4';

  if (!downloadUrl) return res.status(400).send('Missing download URL');

  try {
    const ctx = await getBrowserContext();
    const response = await ctx.request.get(downloadUrl, {
      headers: {
        Origin: 'https://www.diskwala.com',
        Referer: 'https://www.diskwala.com/',
      },
      timeout: 120000,
    });

    const contentType = response.headers()['content-type'] || 'application/octet-stream';
    const contentLength = response.headers()['content-length'];

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fileName)}"`);
    if (contentLength) res.setHeader('Content-Length', contentLength);

    const body = await response.body();
    res.send(body);
  } catch (err) {
    res.status(500).send('Download failed: ' + err.message);
  }
});

process.on('SIGINT', async () => {
  await closeBrowser();
  process.exit();
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Diskwala Downloader running on port ${PORT}`);
});
