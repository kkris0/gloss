import type { Metadata } from "next";
import { Reader } from "@/components/reader/Reader";
import { sampleById } from "@/lib/samples";

type Props = { params: Promise<{ id: string }> };

/**
 * Samples ship with the app, so they get the text's own title. Imported texts
 * live in the browser: the reader renders their <title>. No page here carries
 * a social card or canonical address; the whole instance is behind the login.
 */
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const a = sampleById((await params).id);
  if (!a) return { robots: { index: false } };
  const title = `${a.title}, glossed`;
  const description = a.dek ?? `${a.title}${a.author ? `, by ${a.author}` : ""}. Highlight any line and ask it anything.`;
  return {
    title,
    description,
  };
}

export default async function ReadPage({ params }: Props) {
  const { id } = await params;
  return <Reader id={id} initial={sampleById(id)} />;
}
