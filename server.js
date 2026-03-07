/******************************************************************
 *  server.js – Backend Responses API + Lead email notifier        *
 *  © 2025 – ES Modules ready for Render                          *
 ******************************************************************/

console.log('📦 server.js caricato - avvio inizializzazione...');

/* -------------------- carica .env in locale ------------------- */
import { fileURLToPath } from 'url';
import { dirname } from 'path';
console.log('🔧 Inizializzazione server...');
console.log('🔧 NODE_ENV:', process.env.NODE_ENV);

if (process.env.NODE_ENV !== 'production') {
  try {
    const { config } = await import('dotenv');
    config({ path: `${dirname(fileURLToPath(import.meta.url))}/.env` });
    console.log('✅ .env caricato (locale)');
  } catch (err) {
    console.warn('⚠️  Impossibile caricare .env:', err.message);
  }
} else {
  console.log('✅ Modalità produzione (nessun .env)');
}

/* -------------------- librerie ------------------- */
import express from 'express';
import cors from 'cors';
import nodemailer from 'nodemailer';
import { OpenAI } from 'openai';
import { STUDIO_INSTRUCTIONS } from './prompts/studio.js';

/* -------------------- variabili ambiente ------------------- */
const OPENAI_KEY         = (process.env.OPENAI_KEY         || '').trim();
const GMAIL_APP_PASSWORD = (process.env.GMAIL_APP_PASSWORD || '').trim();

const FROM_EMAIL = 'reservationwebbitz@gmail.com';
const TO_EMAIL   = 'simone@studiomalacarne.com';

console.log('🔍 Verifica variabili ambiente...');
console.log('🔍 OPENAI_KEY presente:', !!OPENAI_KEY);
console.log('🔍 GMAIL_APP_PASSWORD presente:', !!GMAIL_APP_PASSWORD);

if (!OPENAI_KEY || !GMAIL_APP_PASSWORD) {
  console.error('❌  OPENAI_KEY o GMAIL_APP_PASSWORD mancanti nelle variabili ambiente');
  process.exit(1);
}
console.log('✅ Tutte le variabili ambiente sono presenti');

/* -------------------- OpenAI ------------------- */
const openai = new OpenAI({ apiKey: OPENAI_KEY });

const RESPONSES_MODEL = process.env.OPENAI_MODEL || 'gpt-4o';

/* -------------------- Nodemailer ------------------- */
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: FROM_EMAIL,
    pass: GMAIL_APP_PASSWORD
  }
});

/* -------------------- Tool submit_lead per Responses API ------------------- */
const SUBMIT_LEAD_TOOL = {
  type: 'function',
  name: 'submit_lead',
  description: 'Invia i dati del lead allo studio quando hai raccolto almeno un contatto (email o telefono) e preferibilmente nome e descrizione dell\'esigenza. Chiama questa funzione una sola volta per lead, quando l\'utente ha fornito i dati necessari.',
  parameters: {
    type: 'object',
    properties: {
      fullName: {
        type: 'string',
        description: 'Nome e cognome del contatto. Stringa vuota se non fornito.'
      },
      emailAddress: {
        type: 'string',
        description: 'Indirizzo email. Stringa vuota se non fornito.'
      },
      phoneNumber: {
        type: 'string',
        description: 'Numero di telefono. Stringa vuota se non fornito.'
      },
      description: {
        type: 'string',
        description: 'Breve descrizione dell\'esigenza o motivo del contatto. Stringa vuota se non fornito.'
      },
      userType: {
        type: 'string',
        description: 'Tipologia utente: Privato, Professionista o Azienda. Stringa vuota se non specificato.'
      }
    },
    required: ['fullName', 'emailAddress', 'phoneNumber', 'description', 'userType'],
    additionalProperties: false
  },
  strict: true
};

/* -------------------- Express ------------------- */
console.log('🔧 Configurazione Express...');
const app = express();

app.use((req, res, next) => {
  const timestamp = new Date().toISOString();
  console.log(`📥 [${timestamp}] ${req.method} ${req.path} - IP: ${req.ip || req.connection.remoteAddress}`);
  if (req.body && Object.keys(req.body).length > 0) {
    console.log(`📦 Body ricevuto:`, JSON.stringify(req.body).substring(0, 200));
  }
  next();
});

app.use(express.json());
app.use(cors());
console.log('✅ Middleware Express configurati');

/* -------------------- Health Check ------------------- */
app.get('/health', (req, res) => {
  console.log('💚 Health check richiesto');
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});
console.log('✅ Endpoint /health configurato');

/* -------------------- Invio email lead ------------------- */
async function sendLeadEmail(data) {
  const mail = {
    from: `"Chat Assistant" <${FROM_EMAIL}>`,
    to: TO_EMAIL,
    subject: 'Nuovo contatto compilato',
    text: JSON.stringify(data, null, 2)
  };
  await transporter.sendMail(mail);
  console.log('📧 Email lead inviata a:', TO_EMAIL);
}

/* -------------------- POST /api/conversation (Responses API) ------------------- */
app.post('/api/conversation', async (req, res) => {
  console.log('💬 POST /api/conversation - Richiesta ricevuta');
  const { message, previousResponseId } = req.body;
  console.log('💬 previousResponseId:', previousResponseId || 'nuova conversazione');
  console.log('💬 message:', message?.substring(0, 100) || 'vuoto');

  if (!message || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'Campo message obbligatorio e non vuoto' });
  }

  try {
    const input = [{ role: 'user', content: message.trim() }];
    const baseParams = {
      model: RESPONSES_MODEL,
      instructions: STUDIO_INSTRUCTIONS,
      tools: [SUBMIT_LEAD_TOOL],
      tool_choice: 'auto',
      store: true,
      temperature: 0.3
    };

    let response = await openai.responses.create({
      ...baseParams,
      input,
      ...(previousResponseId && { previous_response_id: previousResponseId })
    });

    let leadSubmitted = false;

    // Loop: se la risposta contiene function_call (submit_lead), eseguiamo e richiamiamo l'API
    while (response.output && response.output.some(item => item.type === 'function_call')) {
      const nextInput = [...response.output];

      for (const item of response.output) {
        if (item.type === 'function_call' && item.name === 'submit_lead') {
          let data;
          try {
            data = JSON.parse(item.arguments);
          } catch (e) {
            console.error('💬 submit_lead arguments parse error:', e);
            data = { fullName: '', emailAddress: '', phoneNumber: '', description: '', userType: '' };
          }
          try {
            await sendLeadEmail(data);
            leadSubmitted = true;
            nextInput.push({
              type: 'function_call_output',
              call_id: item.call_id,
              output: JSON.stringify({ success: true, message: 'Lead inviato. Un consulente contatterà l\'utente.' })
            });
          } catch (mailErr) {
            console.error('📧 Errore invio email lead:', mailErr);
            nextInput.push({
              type: 'function_call_output',
              call_id: item.call_id,
              output: JSON.stringify({ success: false, message: 'Errore invio dati. Riprova più tardi.' })
            });
          }
        }
      }

      response = await openai.responses.create({
        ...baseParams,
        input: nextInput,
        previous_response_id: response.id
      });
    }

    console.log('💬 Risposta pronta, leadSubmitted:', leadSubmitted);
    res.json({
      responseId: response.id,
      output: response.output,
      output_text: response.output_text ?? '',
      leadSubmitted
    });
  } catch (err) {
    console.error('❌ /api/conversation error:', err);
    console.error('❌ Stack:', err.stack);
    res.status(500).json({ error: err.message });
  }
});

/* -------------------- avvio server ------------------- */
const PORT = process.env.PORT || 8080;
console.log(`🔧 Tentativo di avvio sulla porta ${PORT}...`);

try {
  app.listen(PORT, () => {
    console.log('='.repeat(50));
    console.log(`🚀  Backend in ascolto sulla porta ${PORT}`);
    console.log(`🌐 Health check: http://localhost:${PORT}/health`);
    console.log(`📡 Endpoint: GET /health, POST /api/conversation`);
    console.log('='.repeat(50));
    console.log('✅ Server pronto (Responses API + submit_lead)');
  });
} catch (err) {
  console.error('❌ Errore durante l\'avvio del server:', err);
  process.exit(1);
}

process.on('uncaughtException', (err) => {
  console.error('❌ Uncaught Exception:', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});
