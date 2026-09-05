export default function RecoveryNotice({ error, onSettings, onDismiss }: { error: string; onSettings: () => void; onDismiss: () => void }) {
  const missingProvider = /No model API key|No OpenAI|API key available/i.test(error);
  const network = /failed to fetch|network error|not connected/i.test(error);
  return <div className="session-error" role="alert"><div>
    <strong>{missingProvider ? "Connect a model to begin" : network ? "The connection was interrupted" : "Something needs attention"}</strong>
    <p>{missingProvider ? "Add a provider in Settings, then try again. Your brief and references are kept here." : network ? "Check that the backend is available, then try again. Your instruction is still here." : error}</p>
    {(missingProvider || network) && <details className="error-detail"><summary>Technical detail</summary><p>{error}</p></details>}
  </div><div className="error-actions">{missingProvider && <button onClick={onSettings}>Connect provider</button>}<button aria-label="Dismiss error" onClick={onDismiss}>Dismiss</button></div></div>;
}
