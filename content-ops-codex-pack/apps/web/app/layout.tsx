import "./globals.css";
import { IBM_Plex_Sans, Space_Grotesk } from "next/font/google";
import { createSupabaseServerClient } from "../lib/supabase";

const bodyFont = IBM_Plex_Sans({
  subsets: ["latin"],
  variable: "--font-body",
  weight: ["300", "400", "500", "600"]
});

const headingFont = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-heading",
  weight: ["500", "600", "700"]
});

const ACTIVE_HEARTBEAT_STATUSES = ["STARTING", "IDLE", "RUNNING", "DEGRADED"];
const HEARTBEAT_STALE_SECONDS = Number.parseInt(process.env.WORKER_HEARTBEAT_STALE_SECONDS || "90", 10);

function formatAge(ms: number) {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return `${hr}h ${remMin}m`;
}

async function getSidebarHeartbeatState() {
  try {
    const supabase = createSupabaseServerClient();
    const { data } = await supabase
      .from("worker_heartbeats")
      .select("last_seen_at,status")
      .in("status", ACTIVE_HEARTBEAT_STATUSES)
      .order("last_seen_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!data?.last_seen_at) {
      return { label: "HB —", tone: "muted", title: "No active worker heartbeat found." };
    }
    const ageMs = Date.now() - new Date(data.last_seen_at).getTime();
    const staleThresholdMs = Math.max(HEARTBEAT_STALE_SECONDS, 1) * 1000;
    const tone = Number.isFinite(ageMs) && ageMs > staleThresholdMs ? "warn" : "ok";
    return {
      label: `HB ${formatAge(ageMs)}`,
      tone,
      title: `Last active heartbeat ${formatAge(ageMs)} ago`
    };
  } catch {
    return { label: "HB —", tone: "muted", title: "Heartbeat unavailable." };
  }
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const heartbeat = await getSidebarHeartbeatState();
  return (
    <html lang="en" className={`${bodyFont.variable} ${headingFont.variable}`}>
      <body>
        <div className="app-shell">
          <aside className="sidebar">
            <div className="logo">Content Ops</div>
            <div className={`sidebar-heartbeat sidebar-heartbeat--${heartbeat.tone}`} title={heartbeat.title}>
              <span className="sidebar-heartbeat-dot" />
              <span>{heartbeat.label}</span>
            </div>
            <nav className="nav">
              <a href="/projects">
                Projects <span>set up</span>
              </a>
              <a href="/templates">
                Templates <span>render</span>
              </a>
              <a href="/queue">
                Queue <span>review</span>
              </a>
              <a href="/jobs">
                Jobs <span>schedule</span>
              </a>
              <a href="/operations">
                Operations <span>workers</span>
              </a>
              <a href="/settings">
                Settings <span>auth</span>
              </a>
            </nav>
            <div className="sidebar-note">Approval-first workflow. Three slots, every day.</div>
          </aside>
          <main className="main">{children}</main>
        </div>
      </body>
    </html>
  );
}
