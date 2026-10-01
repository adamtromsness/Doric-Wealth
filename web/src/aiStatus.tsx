import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from './api';

// Whether AI features can run for the signed-in user: their own key from AI
// Settings, or the server's ANTHROPIC_API_KEY. null while loading (or if the check
// fails), so callers disable AI actions only on a definite "no".
export function useAiConfigured(): boolean | null {
  const [configured, setConfigured] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    api.get<{ configured: boolean }>('/auth/ai-settings')
      .then((s) => { if (live && typeof s?.configured === 'boolean') setConfigured(s.configured); })
      .catch(() => {});
    return () => { live = false; };
  }, []);
  return configured;
}

// Shown next to a disabled AI action, pointing at where to add a key.
export function AiKeyHint({ action }: { action: string }) {
  return (
    <>Add an Anthropic API key in <Link to="/integrations/ai">AI Settings</Link> to {action}.</>
  );
}
