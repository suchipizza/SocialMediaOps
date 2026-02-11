import "./globals.css";
import { IBM_Plex_Sans, Space_Grotesk } from "next/font/google";

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

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${bodyFont.variable} ${headingFont.variable}`}>
      <body>
        <div className="app-shell">
          <aside className="sidebar">
            <div className="logo">Content Ops</div>
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
