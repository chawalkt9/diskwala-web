const express = require('express');
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json());

const USER_DATA_DIR = path.join(__dirname, '.browser-data');
let browserContext = null;
let isHeadless = true;

// Helper to check if custom browser exists
function getExecutablePath() {
  const bravePath = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
  if (fs.existsSync(bravePath)) {
    return bravePath;
  }
  return undefined; // Defaults to Playwright's bundled Chromium
}

async function getBrowserContext(headless = true) {
  if (browserContext) return browserContext;
  isHeadless = headless;

  const executablePath = getExecutablePath();

  browserContext = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless,
    ...(executablePath && { executablePath }),
    viewport: { width: 1280, height: 720 },
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-sync',
      '--disable-blink-features=AutomationControlled',
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

// Login — opens a visible browser for the user to log in via Google
app.post('/api/login', async (_req, res) => {
  try {
    await closeBrowser();
    const ctx = await getBrowserContext(false);
    const page = await ctx.newPage();
    await page.goto('https://www.diskwala.com/login');
    res.json({
      success: true,
      message:
        'Browser opened. Log in via Google, then click "Done Logging In" here.',
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Check if the user is logged in
app.get('/api/check-auth', async (_req, res) => {
  try {
    const ctx = await getBrowserContext();
    const page = await ctx.newPage();

    const authPromise = page.waitForResponse(
      (r) => r.url().includes('/api/v1/auth'),
      { timeout: 20000 }
    );

    await page.goto('https://www.diskwala.com/dashboard', {
      waitUntil: 'domcontentloaded',
      timeout: 20000,
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

// Switch to headless after login
app.post('/api/switch-headless', async (_req, res) => {
  try {
    await closeBrowser();
    await getBrowserContext(true);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get download link for a diskwala URL
app.post('/api/get-download', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });

  const match = url.match(/\/app\/([a-f0-9]+)/);
  if (!match) {
    return res
      .status(400)
      .json({ error: 'Invalid Diskwala URL. Expected: https://www.diskwala.com/app/<id>' });
  }

  const fileId = match[1];

  try {
    const ctx = await getBrowserContext();
    const page = await ctx.newPage();

    // Capture appicrypt headers from any API request on the page
    let capturedAppicrypt = '';
    let capturedTs = '';

    page.on('request', (request) => {
      const h = request.headers();
      if (h['appicrypt'] && request.url().includes('ddudapidd.diskwala.com')) {
        capturedAppicrypt = h['appicrypt'];
        capturedTs = h['appicrypt-ts'] || '';
      }
    });

    // Navigate to trigger WASM token generation
    const tempInfoPromise = page.waitForResponse(
      (r) => r.url().includes('/api/v1/file/temp_info'),
      { timeout: 20000 }
    );

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });

    // Wait for temp_info to complete (confirms WASM loaded and token generated)
    const tempInfoResp = await tempInfoPromise;
    const tempInfo = await tempInfoResp.json().catch(() => null);

    // Give WASM a moment
    await page.waitForTimeout(1000);

    // Get cookies for the API domain
    const cookies = await ctx.cookies('https://ddudapidd.diskwala.com');
    const cookieStr = cookies.map((c) => `${c.name}=${c.value}`).join('; ');

    // Call the sign API with captured appicrypt token + auth cookies
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
    let signBody;
    try {
      signBody = await signResponse.json();
    } catch {
      signBody = await signResponse.text();
    }

    await page.close();

    if (signStatus === 200 && signBody) {
      return res.json({
        success: true,
        fileId,
        fileInfo: tempInfo?.fileInfo || null,
        signData: signBody,
      });
    }

    if (signStatus === 401) {
      return res.json({
        success: false,
        error: 'Not logged in. Please click "Login" first and log in via Google.',
        fileInfo: tempInfo?.fileInfo || null,
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

// Proxy download — streams the file through our server
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

    const contentType =
      response.headers()['content-type'] || 'application/octet-stream';
    const contentLength = response.headers()['content-length'];

    res.setHeader('Content-Type', contentType);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${encodeURIComponent(fileName)}"`
    );
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
  console.log(`\n  Diskwala Downloader running at http://localhost:${PORT}\n`);
});
