import { supabase } from "./supabase.js";

const $ = (id) => document.getElementById(id);

const sektioner = {
  anslut: $("anslut"),
  vantar: $("vantar"),
  fraga: $("fraga"),
  svarat: $("svarat"),
  facit: $("facit"),
  slut: $("slut"),
};

const FARGER = ["rod", "bla", "gul", "gron"];
const SYMBOLER = ["▲", "◆", "●", "■"];

let jag = null;       // min rad i quiz_players
let rum = null;       // rummets rad, uppdateras via realtid
let kanal = null;
let svaratPa = null;  // numret på frågan jag senast svarade på

function visa(namn, resultat = "") {
  for (const [n, s] of Object.entries(sektioner)) s.hidden = n !== namn;
  document.body.dataset.resultat = resultat;
}

function esc(text) {
  const d = document.createElement("div");
  d.textContent = String(text ?? "");
  return d.innerHTML;
}

function alternativText(a) {
  return typeof a === "string" ? a : a.text ?? "";
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

// ---------- Rummet ----------

async function gaIn(rad) {
  jag = rad;
  $("mittnamn").textContent = rad.nickname;

  const { data } = await supabase
    .from("quiz_rooms")
    .select()
    .eq("id", rad.room_id)
    .single();
  rum = data;

  kanal = supabase
    .channel(`spelare-${rad.id}`)
    .on(
      "postgres_changes",
      { event: "UPDATE", schema: "public", table: "quiz_rooms", filter: `id=eq.${rad.room_id}` },
      (p) => {
        rum = p.new;
        rendera();
      }
    )
    .on(
      "postgres_changes",
      { event: "DELETE", schema: "public", table: "quiz_players" },
      (p) => {
        if (jag && p.old.id === jag.id) lamnaRummet("Du är inte längre med i rummet.");
      }
    )
    .subscribe();

  await rendera();
}

async function lamnaRummet(meddelande = "") {
  if (kanal) await supabase.removeChannel(kanal);
  kanal = null;
  jag = null;
  rum = null;
  svaratPa = null;
  $("fel").textContent = meddelande;
  visa("anslut");
}

// ---------- Rendering ----------

async function rendera() {
  if (!rum) return;

  switch (rum.status) {
    case "lobby":
      visa("vantar");
      break;
    case "fraga":
      await visaFraga();
      break;
    case "facit":
      await visaFacit();
      break;
    case "slut":
      await visaSlut();
      break;
  }
}

async function visaFraga() {
  if (svaratPa === rum.fraga_nr) {
    visa("svarat");
    return;
  }

  const { data: f } = await supabase.rpc("quiz_aktuell_fraga", { p_rum: rum.id });
  if (!f) return;

  $("mobilfraga").textContent = f.fraga;
  $("svarsknappar").innerHTML = f.alternativ
    .map(
      (a, i) => `
        <button class="svar ${FARGER[i % 4]}" data-i="${i}">
          <span class="symbol">${SYMBOLER[i % 4]}</span>
          <span>${esc(alternativText(a))}</span>
        </button>`
    )
    .join("");

  visa("fraga");
}

async function visaFacit() {
  const { data: res } = await supabase.rpc("quiz_resultat", { p_rum: rum.id });
  const mig = res?.jag;
  if (!mig) return;

  let rubrik;
  let resultat;
  if (mig.senaste == null) {
    rubrik = "Inget svar";
    resultat = "fel";
  } else if (mig.senaste > 0) {
    rubrik = "Rätt!";
    resultat = "ratt";
  } else {
    rubrik = "Fel";
    resultat = "fel";
  }

  $("facitrubrik").textContent = rubrik;
  $("facitpoang").textContent = `+${mig.senaste ?? 0}`;
  $("facitstatus").textContent = `${mig.poang} poäng · plats ${mig.placering}`;
  visa("facit", resultat);
}

async function visaSlut() {
  const { data: res } = await supabase.rpc("quiz_resultat", { p_rum: rum.id });
  const mig = res?.jag;
  if (!mig) return;

  $("slutplacering").textContent = mig.placering;
  $("slutpoang").textContent = `${mig.poang} poäng`;
  visa("slut");
}

// ---------- Uppstart ----------

const kodIUrl = new URLSearchParams(location.search).get("kod");
if (kodIUrl) {
  $("kod").value = kodIUrl.toUpperCase();
  $("namn").focus();
}

const { data: { session } } = await supabase.auth.getSession();
const plats = session ? await hittaMinPlats(session.user.id) : null;
if (plats) await gaIn(plats);
else visa("anslut");

// ---------- Knappar ----------

$("anslutform").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("fel").textContent = "";
  const knapp = e.submitter;
  knapp.disabled = true;

  const kod = $("kod").value.trim().toUpperCase();
  const namn = $("namn").value.trim();

  try {
    await sakerstallInloggning();

    const { data: hittat } = await supabase
      .from("quiz_rooms")
      .select("id, status")
      .eq("code", kod)
      .maybeSingle();
    if (!hittat) throw new Error("Hittar inget rum med den koden");
    if (hittat.status !== "lobby") throw new Error("Spelet har redan börjat");

    const { data, error } = await supabase
      .from("quiz_players")
      .insert({ room_id: hittat.id, nickname: namn })
      .select("id, nickname, room_id")
      .single();
    if (error?.code === "23505") throw new Error("Namnet är upptaget, välj ett annat");
    if (error) throw error;

    await gaIn(data);
  } catch (err) {
    $("fel").textContent = err.message;
  } finally {
    knapp.disabled = false;
  }
});

$("svarsknappar").addEventListener("click", async (e) => {
  const knapp = e.target.closest("button.svar");
  if (!knapp) return;

  svaratPa = rum.fraga_nr;
  $("svarfel").textContent = "";
  visa("svarat");

  const { error } = await supabase.rpc("quiz_svara", {
    p_rum: rum.id,
    p_svar: Number(knapp.dataset.i),
  });
  if (error) $("svarfel").textContent = error.message;
});

$("lamna").addEventListener("click", async () => {
  const id = jag.id;
  await lamnaRummet();
  await supabase.from("quiz_players").delete().eq("id", id);
});

$("nyttspel").addEventListener("click", async () => {
  $("kod").value = "";
  await lamnaRummet();
});