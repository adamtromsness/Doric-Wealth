import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api';
import { Field } from '../../components/ui';

interface AiSettings { configured: boolean; user_key_set: boolean; key_hint: string | null; env_fallback: boolean; model: string }

const AI_MODELS: [string, string][] = [
  ['claude-sonnet-4-6', 'Sonnet 4.6 — balanced (recommended)'],
  ['claude-opus-4-8', 'Opus 4.8 — most capable'],
  ['claude-haiku-4-5-20251001', 'Haiku 4.5 — fastest / cheapest'],
];

// Integration: your personal Anthropic API key + model, used for AI features.
export default function AiIntegration() {
  const [ai, setAi] = useState<AiSettings | null>(null);
  const [aiKey, setAiKey] = useState('');
  const [aiModel, setAiModel] = useState('');
  const [aiMsg, setAiMsg] = useState('');
  const [err, setErr] = useState('');

  useEffect(() => {
    api.get<AiSettings>('/auth/ai-settings').then((s) => { setAi(s); setAiModel(s.model); }).catch(() => {});
  }, []);

  const saveAiKey = async () => {
    setErr(''); setAiMsg('');
    try {
      const s = await api.put<AiSettings>('/auth/ai-settings', { api_key: aiKey });
      setAi(s); setAiModel(s.model); setAiKey('');
      setAiMsg(s.user_key_set ? 'API key saved — AI is enabled for your account.' : 'API key removed.');
    } catch (e: any) { setErr(e.message); }
  };
  const removeAiKey = async () => {
    setErr(''); setAiMsg('');
    try { const s = await api.put<AiSettings>('/auth/ai-settings', { api_key: '' }); setAi(s); setAiKey(''); setAiMsg('API key removed.'); }
    catch (e: any) { setErr(e.message); }
  };
  const saveAiModel = async () => {
    setErr(''); setAiMsg('');
    try { const s = await api.put<AiSettings>('/auth/ai-settings', { model: aiModel }); setAi(s); setAiMsg('Model saved.'); }
    catch (e: any) { setErr(e.message); }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Integrations</div>
          <h1 className="title">AI</h1>
          <p className="subtitle">Connect an Anthropic API key to enable AI features — cost analysis, receipt &amp; invoice scanning, value estimates, and Q&amp;A over your data.</p>
        </div>
      </div>

      {err && <div className="error" style={{ marginBottom: 16 }}>{err}</div>}

      <div className="card" style={{ marginBottom: 24 }}>
        <div className="banner" style={{ marginBottom: 12, fontSize: 13 }}>
          When you use an AI feature, the data it needs (figures, transactions, or a receipt image) is sent to Anthropic to produce the answer. Don't use AI features with anything you'd rather not share. See <Link to="/privacy">Privacy</Link>.
        </div>
        <p className="muted" style={{ fontSize: 13, margin: '0 0 10px' }}>
          Get a key at <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer">console.anthropic.com</a>.
          It's tied to your account, never shown again, and only used when you trigger an analysis.
        </p>
        <div className="muted" style={{ fontSize: 13, marginBottom: 10 }}>
          Status:{' '}
          {ai == null
            ? '…'
            : ai.configured
              ? <span style={{ color: 'var(--credit)' }}>Enabled{ai.user_key_set ? ` · using your key ${ai.key_hint}` : ' · using the server key'}</span>
              : <span style={{ color: 'var(--debit)' }}>Not configured</span>}
        </div>
        <Field label="Anthropic API Key">
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <input type="password" autoComplete="off" value={aiKey} onChange={(e) => setAiKey(e.target.value)}
              placeholder={ai?.user_key_set ? `Saved (${ai.key_hint}) — enter a new key to replace` : 'sk-ant-…'}
              style={{ flex: 1, minWidth: 240 }} />
            <button className="ghost" disabled={!aiKey.trim()} onClick={saveAiKey}>Save Key</button>
            {ai?.user_key_set && <button className="ghost" onClick={removeAiKey}>Delete</button>}
          </div>
        </Field>
        <Field label="Model">
          <div className="row" style={{ gap: 8 }}>
            <select value={aiModel} onChange={(e) => setAiModel(e.target.value)} style={{ flex: 1, maxWidth: 360 }}>
              {!AI_MODELS.some(([v]) => v === aiModel) && aiModel && <option value={aiModel}>{aiModel}</option>}
              {AI_MODELS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
            </select>
            <button className="ghost" disabled={!aiModel || aiModel === ai?.model} onClick={saveAiModel}>Save Model</button>
          </div>
        </Field>
        {aiMsg && <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>{aiMsg}</div>}
      </div>
    </>
  );
}
