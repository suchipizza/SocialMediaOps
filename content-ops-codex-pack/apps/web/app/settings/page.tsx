export default function SettingsPage() {
  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Settings</h1>
          <p className="page-subtitle">
            Configure tokens, reconnect accounts, and confirm environment health.
          </p>
        </div>
      </div>
      <div className="card-grid">
        <div className="card">
          <h3>Auth status</h3>
          <p>Supabase auth wiring is next. Store IG/TikTok tokens per project.</p>
        </div>
        <div className="card">
          <h3>Storage</h3>
          <p>Template packs live in Supabase Storage for renderer + publisher access.</p>
        </div>
      </div>
    </div>
  );
}
