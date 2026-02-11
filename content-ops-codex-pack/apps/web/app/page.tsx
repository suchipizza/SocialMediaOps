export default function Home() {
  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Dashboard</h1>
          <p className="page-subtitle">
            Build weekly batches, approve the queue, and keep the three-slot cadence without
            manual juggling.
          </p>
        </div>
      </div>
      <div className="card-grid">
        <div className="card">
          <h3>1. Set up a project</h3>
          <p>Connect IG/TikTok, pick time slots, define pillars.</p>
        </div>
        <div className="card">
          <h3>2. Upload templates</h3>
          <p>Validate a template pack and preview the carousel layout.</p>
        </div>
        <div className="card">
          <h3>3. Approve the queue</h3>
          <p>Approve weekly posts, re-render, and schedule to auto-publish.</p>
        </div>
      </div>
    </div>
  );
}
