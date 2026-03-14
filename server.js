const express = require('express');
const nodemailer = require('nodemailer');
let twilioClient = null;
function getTwilio(cfg) {
  if (!cfg.twilioSid || !cfg.twilioToken) throw new Error('Configure Twilio credentials in Settings first');
  return require('twilio')(cfg.twilioSid, cfg.twilioToken);
}
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 3001;
const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'db.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function loadDB() {
  if (!fs.existsSync(DB_PATH)) {
    const init = { config: {}, testers: [], campaigns: [] };
    fs.writeFileSync(DB_PATH, JSON.stringify(init, null, 2));
    return init;
  }
  try { return JSON.parse(fs.readFileSync(DB_PATH, 'utf8')); }
  catch { return { config: {}, testers: [], campaigns: [] }; }
}

function saveDB(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

function createTransporter(cfg) {
  return nodemailer.createTransport({
    host: cfg.smtpHost || 'smtp.gmail.com',
    port: parseInt(cfg.smtpPort) || 587,
    secure: false,
    auth: { user: cfg.senderEmail, pass: cfg.senderPassword }
  });
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── CONFIG ──────────────────────────────────────────────────────────────────
app.get('/api/config', (req, res) => {
  const db = loadDB();
  const cfg = { ...db.config };
  if (cfg.senderPassword) cfg.senderPassword = '••••••••';
  res.json(cfg);
});

app.post('/api/config', (req, res) => {
  const db = loadDB();
  if (req.body.senderPassword === '••••••••') delete req.body.senderPassword;
  db.config = { ...db.config, ...req.body };
  saveDB(db);
  res.json({ success: true });
});

app.post('/api/config/twilio-test', async (req, res) => {
  const db = loadDB();
  try {
    const tc = getTwilio(db.config);
    const account = await tc.api.accounts(db.config.twilioSid).fetch();
    res.json({ success: true, message: `Twilio connected: ${account.friendlyName}` });
  } catch(e) { res.status(400).json({ success: false, message: e.message }); }
});

app.post('/api/config/test', async (req, res) => {
  const db = loadDB();
  try {
    const t = createTransporter(db.config);
    await t.verify();
    res.json({ success: true, message: 'SMTP connection verified!' });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
});

// ── TESTERS ─────────────────────────────────────────────────────────────────
app.get('/api/testers', (req, res) => {
  res.json(loadDB().testers);
});

app.post('/api/testers', (req, res) => {
  const { name, email, department, phone } = req.body;
  if (!name || !email) return res.status(400).json({ error: 'Name and email are required' });
  const db = loadDB();
  if (db.testers.find(t => t.email.toLowerCase() === email.toLowerCase()))
    return res.status(400).json({ error: 'A tester with this email already exists' });
  const tester = { id: uuidv4(), name, email, phone: phone || '', department: department || 'General', createdAt: new Date().toISOString() };
  db.testers.push(tester);
  saveDB(db);
  res.json(tester);
});

app.delete('/api/testers/:id', (req, res) => {
  const db = loadDB();
  db.testers = db.testers.filter(t => t.id !== req.params.id);
  saveDB(db);
  res.json({ success: true });
});

// ── CAMPAIGNS ────────────────────────────────────────────────────────────────
app.get('/api/campaigns', (req, res) => {
  const db = loadDB();
  res.json(db.campaigns.sort((a, b) => new Date(b.deployedAt) - new Date(a.deployedAt)));
});

app.post('/api/campaigns', async (req, res) => {
  const { type, testerId, opName, drillTimeout } = req.body;
  const db = loadDB();
  const tester = db.testers.find(t => t.id === testerId);
  if (!tester) return res.status(404).json({ error: 'Tester not found' });

  const token = uuidv4();
  const host = req.headers.host;
  const campaign = {
    id: uuidv4(), token, type,
    opName: opName || `OP-${type.toUpperCase().replace(/\s/g,'-')}-${Date.now().toString(36).toUpperCase()}`,
    testerId, testerName: tester.name, testerEmail: tester.email,
    status: 'running', deployedAt: new Date().toISOString(),
    result: null, drillTimeout: parseInt(drillTimeout) || 30
  };

  try {
    if (type === 'Phishing Mail')  await deployPhishing(db.config, tester, campaign, host);
    else if (type === 'Fake Update') await deployFakeUpdate(db.config, tester, campaign, host);
    else if (type === 'SMS Phishing') await deploySmsPhishing(db.config, tester, campaign, host);
    else if (type === 'Drill') {
      campaign.drillDeadline = new Date(Date.now() + campaign.drillTimeout * 60000).toISOString();
      await deployDrill(db.config, tester, campaign, host);
    }
    campaign.simUrl = type === 'Fake Update' ? `http://${host}/sim/update/${token}` : null;
    db.campaigns.push(campaign);
    saveDB(db);
    res.json({ success: true, campaign });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

async function deployPhishing(cfg, tester, campaign, host) {
  if (!cfg.senderEmail || !cfg.senderPassword) throw new Error('Configure sender email in Settings first');
  const trackUrl = `http://${host}/track/click/${campaign.token}`;
  const subject = cfg.phishingSubject || '⚠️ Urgent: Your account requires immediate verification';
  await createTransporter(cfg).sendMail({
    from: `"Security Team" <${cfg.senderEmail}>`,
    to: tester.email, subject,
    html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#fff;border:1px solid #ddd;border-radius:4px;overflow:hidden;">
      <div style="background:#c0392b;padding:20px;text-align:center;">
        <h2 style="color:#fff;margin:0;font-size:20px;">🔒 SECURITY ALERT</h2>
        <p style="color:#ffcccc;margin:6px 0 0;font-size:13px;">Immediate action required</p>
      </div>
      <div style="padding:30px;">
        <p style="font-size:15px;">Dear <strong>${tester.name}</strong>,</p>
        <p>Our security system has detected <strong>suspicious login activity</strong> on your account from an unrecognised device. Your account may be at risk.</p>
        <p>To secure your account and prevent unauthorised access, please verify your identity <strong>within the next 24 hours</strong>:</p>
        <div style="text-align:center;margin:32px 0;">
          <a href="${trackUrl}" style="background:#c0392b;color:#fff;padding:16px 36px;text-decoration:none;border-radius:4px;font-size:16px;font-weight:bold;display:inline-block;">🔐 Verify My Account Now</a>
        </div>
        <div style="background:#fff8e1;border-left:4px solid #ffc107;padding:12px 16px;margin:20px 0;border-radius:2px;">
          <strong>⚠ If you do not verify within 24 hours, your account will be temporarily suspended.</strong>
        </div>
        <p style="color:#888;font-size:12px;">If you believe this is an error, contact your IT helpdesk immediately. Do not reply to this email.</p>
      </div>
      <div style="background:#f5f5f5;padding:14px;text-align:center;font-size:11px;color:#999;border-top:1px solid #eee;">
        Security Operations · This message was generated automatically
      </div>
    </div>`
  });
  campaign.emailSentAt = new Date().toISOString();
}

async function deployFakeUpdate(cfg, tester, campaign, host) {
  if (!cfg.senderEmail || !cfg.senderPassword) throw new Error('Configure sender email in Settings first');
  const pageUrl = `http://${host}/sim/update/${campaign.token}`;
  await createTransporter(cfg).sendMail({
    from: `"IT Helpdesk" <${cfg.senderEmail}>`,
    to: tester.email,
    subject: '📋 Action Required: Review Updated IT Security Guidelines',
    html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#fff;border:1px solid #ddd;border-radius:4px;overflow:hidden;">
      <div style="background:#2c3e50;padding:20px;text-align:center;">
        <h2 style="color:#fff;margin:0;font-size:18px;">IT Department — Notice</h2>
      </div>
      <div style="padding:30px;">
        <p>Dear <strong>${tester.name}</strong>,</p>
        <p>The IT Department has published updated security guidelines that require your review.</p>
        <p>Please access the document using the button below. A short acknowledgment will be required after reviewing.</p>
        <div style="text-align:center;margin:32px 0;">
          <a href="${pageUrl}" style="background:#2980b9;color:#fff;padding:16px 36px;text-decoration:none;border-radius:4px;font-size:16px;font-weight:bold;display:inline-block;">📄 Open Security Document</a>
        </div>
        <p style="color:#888;font-size:12px;">Please open this from your primary work device. For issues, contact the helpdesk.</p>
      </div>
    </div>`
  });
  campaign.emailSentAt = new Date().toISOString();
}

async function deployDrill(cfg, tester, campaign, host) {
  if (!cfg.senderEmail || !cfg.senderPassword) throw new Error('Configure sender email in Settings first');
  const drillUrl = `http://${host}/sim/drill/${campaign.token}`;
  await createTransporter(cfg).sendMail({
    from: `"Security Operations" <${cfg.senderEmail}>`,
    to: tester.email,
    subject: `[DRILL] ${campaign.opName} — Response Required Within ${campaign.drillTimeout} Minutes`,
    html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#fff;border:1px solid #ddd;border-radius:4px;overflow:hidden;">
      <div style="background:#e67e22;padding:20px;text-align:center;">
        <h2 style="color:#fff;margin:0;font-size:20px;">⚠ SECURITY DRILL</h2>
        <p style="color:#ffecc8;margin:6px 0 0;font-size:13px;">Mandatory acknowledgment required</p>
      </div>
      <div style="padding:30px;">
        <p>Dear <strong>${tester.name}</strong>,</p>
        <p>This is a <strong>mandatory security awareness drill</strong> as part of your organisation's cybersecurity training programme.</p>
        <div style="background:#fff3cd;border:1px solid #ffc107;border-radius:4px;padding:16px;margin:20px 0;">
          <table style="width:100%;font-size:14px;"><tr>
            <td><strong>⏱ Response window:</strong></td><td>${campaign.drillTimeout} minutes</td>
          </tr><tr>
            <td><strong>📋 Operation ID:</strong></td><td>${campaign.opName}</td>
          </tr><tr>
            <td><strong>👤 Assigned to:</strong></td><td>${tester.name}</td>
          </tr></table>
        </div>
        <p>You must click <strong>"Acknowledge Alert"</strong> within <strong>${campaign.drillTimeout} minutes</strong>. Your response time is being recorded.</p>
        <div style="text-align:center;margin:32px 0;">
          <a href="${drillUrl}" style="background:#27ae60;color:#fff;padding:16px 36px;text-decoration:none;border-radius:4px;font-size:16px;font-weight:bold;display:inline-block;">✅ Acknowledge Alert</a>
        </div>
        <p style="color:#888;font-size:12px;">Non-response will be recorded in your security assessment. This is a simulation — no real threat exists.</p>
      </div>
    </div>`
  });
  campaign.emailSentAt = new Date().toISOString();
}

// ── TRACKING ─────────────────────────────────────────────────────────────────
app.get('/track/click/:token', (req, res) => {
  const db = loadDB();
  const c = db.campaigns.find(x => x.token === req.params.token);
  if (c && c.status === 'running') {
    c.status = 'complete';
    c.result = { action: 'trapped', clickedAt: new Date().toISOString(), responseTimeMs: Date.now() - new Date(c.deployedAt).getTime() };
    saveDB(db);
  }
  res.redirect('/sim/phishing-caught');
});

app.post('/track/update/:token', (req, res) => {
  const { action } = req.body;
  const db = loadDB();
  const c = db.campaigns.find(x => x.token === req.params.token);
  if (c && c.status === 'running') {
    c.status = 'complete';
    c.result = { action: action === 'install' ? 'trapped' : 'responded', respondedAt: new Date().toISOString(), responseTimeMs: Date.now() - new Date(c.deployedAt).getTime() };
    saveDB(db);
  }
  res.json({ success: true });
});

app.post('/track/drill/:token', (req, res) => {
  const db = loadDB();
  const c = db.campaigns.find(x => x.token === req.params.token);
  if (c && c.status === 'running') {
    const ms = Date.now() - new Date(c.deployedAt).getTime();
    c.status = 'complete';
    c.result = { action: 'responded', respondedAt: new Date().toISOString(), responseTimeMs: ms, responseTimeMins: Math.round(ms / 60000 * 10) / 10 };
    saveDB(db);
  }
  res.json({ success: true });
});

// ── SIM PAGES ─────────────────────────────────────────────────────────────────
app.get('/sim/update/:token', (req, res) => {
  const db = loadDB();
  const c = db.campaigns.find(x => x.token === req.params.token);
  if (c && !c.openedAt) { c.openedAt = new Date().toISOString(); saveDB(db); }
  res.sendFile(path.join(__dirname, 'public', 'fake-update.html'));
});
app.get('/sim/sms/:token', (req, res) => {
  const db = loadDB();
  const c = db.campaigns.find(x => x.token === req.params.token);
  if (c && !c.openedAt) { c.openedAt = new Date().toISOString(); saveDB(db); }
  res.sendFile(path.join(__dirname, 'public', 'sms-trap.html'));
});
app.post('/track/sms/:token', (req, res) => {
  const { action } = req.body; // 'registered' or 'closed'
  const db = loadDB();
  const c = db.campaigns.find(x => x.token === req.params.token);
  if (c && c.status === 'running') {
    c.status = 'complete';
    c.result = { action: action === 'registered' ? 'trapped' : 'responded', respondedAt: new Date().toISOString(), responseTimeMs: Date.now() - new Date(c.deployedAt).getTime() };
    saveDB(db);
  }
  res.json({ success: true });
});
app.get('/sim/drill/:token', (req, res) => res.sendFile(path.join(__dirname, 'public', 'drill.html')));
app.get('/sim/phishing-caught', (req, res) => res.sendFile(path.join(__dirname, 'public', 'phishing-caught.html')));

// ── REPORTS ───────────────────────────────────────────────────────────────────
app.get('/api/reports', (req, res) => {
  const db = loadDB();
  res.json(db.testers.map(t => buildReport(t, db.campaigns)));
});

function buildReport(tester, campaigns) {
  const mine = campaigns.filter(c => c.testerId === tester.id);
  const done = mine.filter(c => c.status === 'complete' && c.result);
  let risk = 0, trapped = 0, responded = 0, ignored = 0;
  done.forEach(c => {
    if (c.result.action === 'trapped') { trapped++; risk += c.type === 'Phishing Mail' ? 40 : c.type === 'Fake Update' ? 35 : c.type === 'SMS Phishing' ? 35 : 30; }
    else if (c.result.action === 'responded') { responded++; }
    else if (c.result.action === 'ignored') { ignored++; risk += 20; }
  });
  const score = Math.max(0, 100 - risk);
  return {
    tester, campaigns: mine,
    stats: { total: mine.length, completed: done.length, trapped, responded, ignored },
    riskScore: score,
    riskLevel: score >= 80 ? 'LOW' : score >= 60 ? 'MEDIUM' : score >= 40 ? 'HIGH' : 'CRITICAL',
    generatedAt: new Date().toISOString()
  };
}

// ── SMS PHISHING DEPLOY ──────────────────────────────────────────────────────
async function deploySmsPhishing(cfg, tester, campaign, host) {
  if (!tester.phone) throw new Error('This tester has no phone number. Add it in Groups first.');
  const tc = getTwilio(cfg);
  const pageUrl = `http://${host}/sim/sms/${campaign.token}`;
  const messages = [
    `ALERT: Your SBI account has been credited Rs.50,000 as part of govt cashback scheme. Claim now before it expires: ${pageUrl}`,
    `Congratulations! You have been selected for Rs.25,000 cash prize by NPCI. Verify your UPI to receive funds: ${pageUrl}`,
    `[HDFC Bank] Your account is eligible for Rs.1,00,000 lucky draw prize. Complete KYC to claim: ${pageUrl}`,
    `PAYTM: Rs.75,000 cashback pending in your wallet. Verify your details within 2 hours to receive: ${pageUrl}`
  ];
  const msg = messages[Math.floor(Math.random() * messages.length)];
  await tc.messages.create({
    body: msg,
    from: cfg.twilioPhone,
    to: tester.phone
  });
  campaign.smsText = msg;
  campaign.smsSentAt = new Date().toISOString();
}

// ── RESET ALL DATA ────────────────────────────────────────────────────────────
app.post('/api/reset', (req, res) => {
  const db = loadDB();
  const config = db.config; // preserve SMTP settings
  saveDB({ config, testers: [], campaigns: [] });
  res.json({ success: true });
});

// ── AUTO EXPIRY ───────────────────────────────────────────────────────────────
setInterval(() => {
  const db = loadDB(); let changed = false; const now = Date.now();
  db.campaigns.forEach(c => {
    if (c.status !== 'running') return;
    if (c.type === 'Drill' && c.drillDeadline && now > new Date(c.drillDeadline).getTime()) {
      c.status = 'complete'; c.result = { action: 'ignored', expiredAt: new Date().toISOString() }; changed = true;
    }
    if (c.type === 'SMS Phishing' && now - new Date(c.deployedAt).getTime() > 24 * 3600000 && !c.openedAt) {
      c.status = 'complete'; c.result = { action: 'ignored', expiredAt: new Date().toISOString() }; changed = true;
    }
    if (c.type === 'SMS Phishing' && c.openedAt && now - new Date(c.openedAt).getTime() > 60 * 60000 && c.status === 'running') {
      c.status = 'complete'; c.result = { action: 'responded', note: 'Opened but did not register', respondedAt: new Date().toISOString(), responseTimeMs: now - new Date(c.deployedAt).getTime() }; changed = true;
    }
    if (c.type === 'Phishing Mail' && now - new Date(c.deployedAt).getTime() > 48 * 3600000) {
      c.status = 'complete'; c.result = { action: 'ignored', expiredAt: new Date().toISOString() }; changed = true;
    }
    if (c.type === 'Fake Update' && c.openedAt && now - new Date(c.openedAt).getTime() > 30 * 60000) {
      c.status = 'complete'; c.result = { action: 'responded', note: 'Did not click install', respondedAt: new Date().toISOString(), responseTimeMs: now - new Date(c.deployedAt).getTime() }; changed = true;
    }
  });
  if (changed) saveDB(db);
}, 60000);

app.listen(PORT, () => {
  console.log(`\n  ██████╗██╗   ██╗██████╗ ███████╗██████╗\n  ██╔════╝╚██╗ ██╔╝██╔══██╗██╔════╝██╔══██╗\n  ██║      ╚████╔╝ ██████╔╝█████╗  ██████╔╝\n  ██║       ╚██╔╝  ██╔══██╗██╔══╝  ██╔══██╗\n  ╚██████╗   ██║   ██████╔╝███████╗██║  ██║\n   ╚═════╝   ╚═╝   ╚═════╝ ╚══════╝╚═╝  ╚═╝\n\n  🟢  Running → http://localhost:${PORT}\n`);
});