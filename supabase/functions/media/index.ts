const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function svar(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const { sok, id } = await req.json();

    let url: string;
    if (id) {
      url = `https://itunes.apple.com/lookup?id=${encodeURIComponent(id)}&country=se`;
    } else if (sok) {
      url = `https://itunes.apple.com/search?term=${encodeURIComponent(sok)}` +
        `&media=music&entity=song&limit=15&country=se`;
    } else {
      throw new Error("Ange sok eller id");
    }

    const itunes = await fetch(url);
    if (!itunes.ok) throw new Error(`iTunes svarade ${itunes.status}`);
    const data = await itunes.json();

    const latar = data.results
      .filter((r: any) => r.kind === "song" && r.previewUrl)
      .map((r: any) => ({
        id: String(r.trackId),
        titel: r.trackName,
        artist: r.artistName,
        album: r.collectionName,
        ar: r.releaseDate?.slice(0, 4) ?? null,
        bild: r.artworkUrl100?.replace("100x100", "300x300") ?? null,
        ljud: r.previewUrl,
      }));

    return svar(latar);
  } catch (err) {
    return svar({ error: (err as Error).message }, 400);
  }
});