import type { Metadata } from "next";
import { IBM_Plex_Mono, Space_Grotesk } from "next/font/google";
import "./globals.css";
import { APP_VERSION } from "@/lib/version";

const spaceGrotesk = Space_Grotesk({
  variable: "--font-space-grotesk",
  subsets: ["latin"],
});

const ibmPlexMono = IBM_Plex_Mono({
  variable: "--font-ibm-plex-mono",
  weight: ["400", "500"],
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Chatinterface",
  description: "Secure NanoGPT chat interface with account auth, encrypted storage, and tool-capable agent flows.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${spaceGrotesk.variable} ${ibmPlexMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        {children}
        <div
          aria-hidden
          className="pointer-events-none fixed bottom-2 right-3 z-50 select-none font-mono text-[11px] tabular-nums text-slate-500/70"
        >
          {APP_VERSION}
        </div>
      </body>
    </html>
  );
}
