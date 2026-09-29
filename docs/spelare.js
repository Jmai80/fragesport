import { supabase } from "./supabase.js";

const anslut = document.getElementById("anslut");
const vantar = document.getElementById("vantar");
const fel = document.getElementById("fel");

let jag = null;   // min rad i quiz_players
let kanal = null;

function visa(sektion) {
  for (const s of [anslut, vantar]) s.hidden = s !== sektion;
}

// ---------- Inloggning och plats ----------

async function sakerstallInloggning() {
  const { data: { session } } = await supabase.auth.getSession();
  if (session) return session.user;

  const { data, error } = await supabase.auth.signInAnonymously();
  if (error) throw error;
  return data.user;
}

async function hittaMinPlats(userId) {
  const { data } = await supabase
    .from("quiz_players")
    .select("id, nickname, room_id, quiz_rooms!inner(status)")
    .eq("user_id", userId)
    .neq("quiz_rooms.status", "slut")
    .order("joined_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data;
}

// ---------- Väntläget ----------

function borjaVanta(rad) {
  jag = rad;
  document.getElementById("mittnamn").textContent = rad.nickname;

  kanal = supabase
    .channel(`spelare-${rad.id}`)
    .on(
      "postgres_changes",
      { event: "DELETE", schema: "public", table: "quiz_players" },
      (p) => {
        if (jag && p.old.id === jag.id) lamnaVantlaget("Du är inte längre med i rummet.");
      }
    )
    .subscribe();

  visa(vantar);
}

async function lamnaVantlaget(meddelande = "") {
  if (kanal) await supabase.removeChannel(kanal);
  kanal = null;
  jag = null;
  fel.textContent = meddelande;
  visa(anslut);
}

// ---------- Uppstart ----------

const kodIUrl = new URLSearchParams(location.search).get("kod");
if (kodIUrl) document.getElementById("kod").value = kodIUrl.toUpperCase();

const { data: { session } } = await supabase.auth.getSession();
const plats = session ? await hittaMinPlats(session.user.id) : null;
if (plats) borjaVanta(plats);
else visa(anslut);

// ---------- Knappar ----------

document.getElementById("anslutform").addEventListener("submit", async (e) => {
  e.preventDefault();
  fel.textContent = "";
  const knapp = e.submitter;
  knapp.disabled = true;

  const kod = document.getElementById("kod").value.trim().toUpperCase();
  const namn = document.getElementById("namn").value.trim();

  try {
    await sakerstallInloggning();

    const { data: rum } = await supabase
      .from("quiz_rooms")
      .select("id, status")
      .eq("code", kod)
      .maybeSingle();
    if (!rum) throw new Error("Hittar inget rum med den koden");
    if (rum.status !== "lobby") throw new Error("Spelet har redan börjat");

    const { data, error } = await supabase
      .from("quiz_players")
      .insert({ room_id: rum.id, nickname: namn })
      .select("id, nickname, room_id")
      .single();
    if (error?.code === "23505") throw new Error("Namnet är upptaget, välj ett annat");
    if (error) throw error;

    borjaVanta(data);
  } catch (err) {
    fel.textContent = err.message;
  } finally {
    knapp.disabled = false;
  }
});

document.getElementById("lamna").addEventListener("click", async () => {
  const id = jag.id;
  await lamnaVantlaget();
  await supabase.from("quiz_players").delete().eq("id", id);
});