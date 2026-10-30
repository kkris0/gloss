import type { Metadata, Viewport } from "next";
import { Atkinson_Hyperlegible_Next, Literata, Newsreader, Schibsted_Grotesk } from "next/font/google";
import { BOOT_SCRIPT } from "@/lib/settings";
import "./globals.css";
import { Tooltips } from "@/components/ui/Tooltips";
import { SyncAgent } from "@/components/account/SyncAgent";

const serif = Newsreader({
  subsets: ["latin", "latin-ext"],
  axes: ["opsz"],
  style: ["normal", "italic"],
  variable: "--nf-serif",
  display: "swap",
});

const sans = Schibsted_Grotesk({
  subsets: ["latin"],
  variable: "--nf-sans",
  display: "swap",
});

// Optional reading faces: declared here, fetched only when a reader picks them.
const book = Literata({
  subsets: ["latin", "latin-ext"],
  axes: ["opsz"],
  style: ["normal", "italic"],
  variable: "--nf-book",
  display: "swap",
  preload: false,
});

const legible = Atkinson_Hyperlegible_Next({
  subsets: ["latin", "latin-ext"],
  style: ["normal", "italic"],
  variable: "--nf-legible",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
});

const DESCRIPTION = "Highlight any line and ask it anything. The answer is written in the margin, beside the words, citing the paragraphs it used.";

// A private instance: no social card, no canonical origin, nothing for a crawler or a link preview.
export const metadata: Metadata = {
  title: { default: "Gloss", template: "%s" },
  description: DESCRIPTION,
  applicationName: "Gloss",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f6f3ec" },
    { media: "(prefers-color-scheme: dark)", color: "#151412" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${serif.variable} ${sans.variable} ${book.variable} ${legible.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: BOOT_SCRIPT }} />
      </head>
      <body>
        {children}
        <SyncAgent />
        <Tooltips />
      </body>
    </html>
  );
}
