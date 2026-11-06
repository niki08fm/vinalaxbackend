import express from 'express';
import mongoose from 'mongoose';
import cors from 'cors';
import dotenv from 'dotenv';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';

// Load variables from our .env configuration file
dotenv.config();
const app = express();

// Middleware rules
// CORS_ORIGINS: comma-separated list of allowed site origins, e.g.
// "https://www.vinalaxhrsolutions.com,https://vinalaxhrsolutions.com".
// When unset every origin is allowed (previous behaviour, handy for local dev).
const corsOrigins = (process.env.CORS_ORIGINS || '').split(',').map(o => o.trim()).filter(Boolean);
app.use(cors({
  origin: corsOrigins.length ? corsOrigins : true,
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));
app.use(express.json()); // Allows the backend to read incoming JSON packages from React

// ── 1. ESTABLISH MONGO DATABASE CONNECTION ──
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('✅ MongoDB connected natively to Vinalax database'))
  .catch((err) => console.error('❌ Database connection failure:', err));

// ── 2. DATA BLUEPRINTS (SCHEMAS) ──

// Customer Inquiry Data Blueprint
const enquirySchema = new mongoose.Schema({
  name: { type: String, required: true },
  company: { type: String, default: '' },
  phone: { type: String, required: true },
  service: { type: String, required: true },
  message: { type: String, default: '' },
  date: { type: String, required: true }
}, { timestamps: true });

const Enquiry = mongoose.model('Enquiry', enquirySchema);

// Admin Account Security Blueprint
const adminSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true }
});

const Admin = mongoose.model('Admin', adminSchema);

// ── 3. SECURE JWT VERIFICATION MIDDLEWARE GATE ──
// This function sits in front of your private data routes to verify credentials
const verifyToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  // Expecting header format: "Bearer <JWT_TOKEN_STRING>"
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ success: false, message: 'Access Denied: Missing security token keys.' });
  }

  try {
    const verified = jwt.verify(token, process.env.JWT_SECRET);
    req.adminUser = verified; // Append verified user details to the request context
    next(); // Pass to the next logic route handler function safely
  } catch (err) {
    res.status(403).json({ success: false, message: 'Session expired or invalid authentication parameters.' });
  }
};

// ── 4. BACKEND API ROUTE DEFINITIONS ──

// Health check for PM2/nginx/load-balancer checks (does not touch the database).
app.get('/api/health', (req, res) => {
  res.json({ success: true, service: 'vinalax-website-backend', db: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected' });
});

// LOGIN AUTHENTICATION ROUTE (Checks credentials, issues signed JWT pass)
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    const admin = await Admin.findOne({ email });
    if (!admin) {
      return res.status(400).json({ success: false, message: 'Invalid identity credential mappings.' });
    }

    // Safely compare raw text with the encrypted password hash string in our DB
    const validPassword = await bcrypt.compare(password, admin.password);
    if (!validPassword) {
      return res.status(400).json({ success: false, message: 'Invalid security access token keys.' });
    }

    // Sign details into an immutable encryption string token valid for 24 hours
    const token = jwt.sign({ id: admin._id, email: admin.email }, process.env.JWT_SECRET, { expiresIn: '24h' });

    res.status(200).json({
      success: true,
      token: token,
      message: 'Authentication successful.'
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// PUBLIC SUBMISSION ROUTE (Saves client entries from public website home page)
app.post('/api/enquiries', async (req, res) => {
  try {
    const { fname, lname, company, phone, service, message } = req.body;
    const fullName = `${fname} ${lname}`.trim();
    const todayISO = new Date().toISOString().split('T')[0]; // Format: YYYY-MM-DD

    const newEnquiry = new Enquiry({
      name: fullName,
      company: company || '',
      phone: phone,
      service: service,
      message: message || '',
      date: todayISO
    });

    await newEnquiry.save();
    res.status(201).json({ success: true, message: 'Enquiry safely saved to database!' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// PROTECTED FETCH ROUTE (Reads entries from database; requires valid verifyToken JWT pass)
app.get('/api/enquiries', verifyToken, async (req, res) => {
  try {
    const list = await Enquiry.find().sort({ createdAt: -1 }); // Sort newest to oldest
    
    // Structure records into the properties your frontend layout expects
    const mappedList = list.map(e => ({
      id: e._id,
      name: e.name,
      company: e.company,
      phone: e.phone,
      service: e.service,
      message: e.message,
      date: e.date
    }));

    res.status(200).json(mappedList);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// PROTECTED DELETE ROUTE (Removes single entries from table; requires valid verifyToken JWT pass)
app.delete('/api/enquiries/:id', verifyToken, async (req, res) => {
  try {
    await Enquiry.findByIdAndDelete(req.params.id);
    res.status(200).json({ success: true, message: 'Record cleared successfully!' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ── 4b. CLIENT PORTAL (Company / Employee) ──
// This is a THIN PROXY, not a second data model: companies and employees, and
// all their payroll/payslip data, live in the separate HR system's MySQL
// database and are managed from its admin panel. This backend never stores or
// duplicates that data — every client-portal route below just forwards the
// caller's request (and Bearer token) to the HR system's API and relays back
// its response byte-for-byte, whether that's JSON, a PDF, an Excel file, or a
// ZIP. Kept fully separate from the marketing-site Admin/Enquiry routes above.
const HR_API_BASE_URL = process.env.HR_API_BASE_URL || 'http://localhost:5001/api';

async function proxyToHR(req, res, hrPath) {
  const qs = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
  try {
    const upstream = await fetch(`${HR_API_BASE_URL}${hrPath}${qs}`, {
      method: req.method,
      headers: {
        'Content-Type': 'application/json',
        ...(req.headers.authorization ? { Authorization: req.headers.authorization } : {})
      },
      body: ['POST', 'PUT', 'DELETE'].includes(req.method) ? JSON.stringify(req.body || {}) : undefined
    });

    const contentType = upstream.headers.get('content-type') || '';
    const disposition = upstream.headers.get('content-disposition');
    if (disposition) res.setHeader('Content-Disposition', disposition);
    res.status(upstream.status);

    if (contentType.includes('application/json')) {
      res.json(await upstream.json());
    } else {
      res.setHeader('Content-Type', contentType || 'application/octet-stream');
      res.send(Buffer.from(await upstream.arrayBuffer()));
    }
  } catch (error) {
    console.error('[proxyToHR] Could not reach HR system:', error.message);
    res.status(502).json({ success: false, message: 'Could not reach the HR system. Please try again shortly.' });
  }
}

// Login (company or employee — the HR system tells us which via the returned user.role)
// Only company and employee accounts may sign in through the public website;
// HR admin/manager accounts must use the HR software itself.
const CLIENT_ROLES = ['COMPANY', 'EMPLOYEE'];
app.post('/api/client/login', async (req, res) => {
  try {
    const upstream = await fetch(`${HR_API_BASE_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body || {})
    });
    const raw = await upstream.text();
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      console.error(`[client login] HR system returned non-JSON (status ${upstream.status}, type ${upstream.headers.get('content-type')}, body type ${typeof req.body}): ${raw.slice(0, 300)}`);
      return res.status(502).json({ success: false, message: 'Unexpected response from the HR system.' });
    }
    if (upstream.ok && data.user && !CLIENT_ROLES.includes(data.user.role)) {
      return res.status(403).json({ success: false, message: 'This account cannot use the client portal. Please sign in to the HR software instead.' });
    }
    res.status(upstream.status).json(data);
  } catch (error) {
    console.error('[client login] Could not reach HR system:', error.message);
    res.status(502).json({ success: false, message: 'Could not reach the HR system. Please try again shortly.' });
  }
});
app.get('/api/client/me', (req, res) => proxyToHR(req, res, '/auth/me'));
app.put('/api/client/change-password', (req, res) => proxyToHR(req, res, '/auth/change-password'));

// Company self-service (role = COMPANY)
app.get('/api/client/company/payrolls', (req, res) => proxyToHR(req, res, '/company-portal/payrolls'));
app.get('/api/client/company/payrolls/:runId/excel', (req, res) => proxyToHR(req, res, `/company-portal/payrolls/${req.params.runId}/excel`));
app.get('/api/client/company/payrolls/:runId', (req, res) => proxyToHR(req, res, `/company-portal/payrolls/${req.params.runId}`));
app.get('/api/client/company/payslips/download-zip', (req, res) => proxyToHR(req, res, '/company-portal/payslips/download-zip'));
app.get('/api/client/company/payslips/:payslipId/pdf', (req, res) => proxyToHR(req, res, `/company-portal/payslips/${req.params.payslipId}/pdf`));
app.get('/api/client/company/payslips/:payslipId', (req, res) => proxyToHR(req, res, `/company-portal/payslips/${req.params.payslipId}`));
app.get('/api/client/company/payslips', (req, res) => proxyToHR(req, res, '/company-portal/payslips'));
app.get('/api/client/company/reports/pf-ecr', (req, res) => proxyToHR(req, res, '/company-portal/reports/pf-ecr'));
app.get('/api/client/company/reports/esi', (req, res) => proxyToHR(req, res, '/company-portal/reports/esi'));
app.get('/api/client/company/reports/bank', (req, res) => proxyToHR(req, res, '/company-portal/reports/bank'));

// Employee self-service (role = EMPLOYEE) — self-scoped by the HR system from the JWT
app.get('/api/client/employee/payslips/:payslipId/pdf', (req, res) => proxyToHR(req, res, `/payslips/my/${req.params.payslipId}/pdf`));
app.get('/api/client/employee/payslips', (req, res) => proxyToHR(req, res, '/payslips/my'));

// ── 5. START SERVER ──
const PORT = process.env.PORT || 5002;

app.listen(PORT, async () => {
  console.log(`🚀 Vinalax website backend running on port ${PORT}`);

  // Website admin seeding. The password is never hard-coded and existing
  // passwords are left alone unless ADMIN_RESET_PASSWORD=true is set once.
  try {
    const adminEmail = (process.env.ADMIN_EMAIL || 'admin@vinalax.com').trim().toLowerCase();
    const adminPassword = process.env.ADMIN_PASSWORD;
    const admin = await Admin.findOne({ email: adminEmail });

    if (!admin) {
      if (!adminPassword || adminPassword.length < 10) {
        console.warn('⚠️ No website admin exists. Set ADMIN_PASSWORD (10+ characters) in .env and restart to create one.');
        return;
      }
      await Admin.create({ email: adminEmail, password: await bcrypt.hash(adminPassword, 10) });
      console.log(`⭐ Website admin ${adminEmail} created.`);
    } else if (process.env.ADMIN_RESET_PASSWORD === 'true' && adminPassword && adminPassword.length >= 10) {
      admin.password = await bcrypt.hash(adminPassword, 10);
      await admin.save();
      console.log(`⭐ Website admin ${adminEmail} password reset. Remove ADMIN_RESET_PASSWORD from .env now.`);
    }
  } catch (syncError) {
    console.error('⚠️ Could not complete website admin setup:', syncError.message);
  }
});
