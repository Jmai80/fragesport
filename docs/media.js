import { supabase } from "./supabase.js";

// ---------- Musik via vår Edge Function ----------

export async function sokLatar(sok) {
  const { data, error } = await supabase.functions.invoke("media", { body: { sok } });
  if (error) throw error;
  return data;
}

export async function hamtaLat(id) {
  const { data, error } = await supabase.functions.invoke("media", { body: { id } });
  if (error) throw error;
  return data[0] ?? null;
}

// ---------- Bilder direkt från Wikimedia Commons ----------

export async function sokBilder(sok) {
  const params = new URLSearchParams({
    action: "query",
    format: "json",
    origin: "*",
    generator: "search",
    gsrnamespace: "6",
    gsrlimit: "24",
    gsrsearch: `filetype:bitmap ${sok}`,
    prop: "imageinfo",
    iiprop: "url|extmetadata",
    iiurlwidth: "300",
  });

  const svar = await fetch(`https://commons.wikimedia.org/w/api.php?${params}`);
  if (!svar.ok) throw new Error("Wikimedia svarade inte");
  const data = await svar.json();

  return Object.values(data.query?.pages ?? {})
    .sort((a, b) => a.index - b.index)
    .map((p) => {
      const info = p.imageinfo?.[0] ?? {};
      const meta = info.extmetadata ?? {};
      return {
        ref: p.title.replace(/^File:/, ""),
        tumnagel: info.thumburl,
        upphov: rensaHtml(meta.Artist?.value),
        licens: meta.LicenseShortName?.value ?? "",
      };
    });
}

// Wikimedia skickar upphovsperson som HTML. DOMParser läser den utan att
// köra något, till skillnad från innerHTML, som kan ladda bilder och skript.
function rensaHtml(html = "") {
  return new DOMParser().parseFromString(html, "text/html").body.textContent.trim();
}

export function bildUrl(media, bredd = 800) {
  if (media?.typ !== "bild") return null;
  if (media.kalla === "wikimedia") {
    return `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(media.ref)}?width=${bredd}`;
  }
  if (media.kalla === "url") return media.ref;
  return null;
}