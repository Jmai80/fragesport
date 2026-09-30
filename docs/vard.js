import { supabase } from "./supabase.js";
import QRCode from "https://esm.sh/qrcode@1";

const login = document.getElementById("login");
const start = document.getElementById("start");
const lobby = document.getElementById("lobby");

let rum = null;
let spelare = [];
let kanal = null;

function visa(sektion) {
  for (const s of [login, start, lobby]) s.hidden = s !== sektion;
}

function arVard(session) {
  return session && !session.user.is_anonymous;
}

function esc(text) {
  const d = document.createElement("div");
  d.textContent = String(text ?? "");
  return d.innerHTML;
}

// ---------- Rum ----------

async function skapaRum() {
  // Koden slumpas i databasen. Krockar den med ett befintligt rum
  // (felkod 23505 = unique violation) försöker vi igen.
  for (let forsok = 0; forsok < 3; forsok++) {
    const { data, error } = await supabase
      .from("quiz_rooms")
      .insert({})
      .select()
      .single();
    if (!error) return data;
    if (error.code !== "23505") throw error;
  }
  throw new Error("Kunde inte skapa en unik kod, försök igen");
}

async function hittaOppetRum(userId) {
  const { data } = await supabase
    .from("quiz_rooms")
    .select()
    .eq("host_id", userId)
    .neq("status", "slut")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data;
}

// ---------- Lobby ----------

function ritaSpelare() {
  document.getElementById("antal").textContent =
    spelare.length === 1 ? "1 spelare" : `${spelare.length} spelare`;

  document.getElementById("spelarlista").innerHTML = spelare
    .map(
      (s) =>
        `<li><button class="spelare" data-id="${s.id}" title="Klicka för att ta bort">${esc(s.nickname)}</button></li>`
    )
    .join("");
}

async function oppnaLobby(nyttRum) {
  rum = nyttRum;

  const adress = new URL("./", location.href);
  document.getElementById("adress").textContent = adress.host + adress.pathname;
  document.getElementById("kod").textContent = rum.code;
    const lank = new URL(`./?kod=${rum.code}`, location.href).href;
  document.getElementById("qr").innerHTML = await QRCode.toString(lank, {
    type: "svg",
    margin: 1,
    color: { dark: "#1c1917", light: "#ffffff" },
  });

  const { data } = await supabase
    .from("quiz_players")
    .select("id, nickname")
    .eq("room_id", rum.id)
    .order("joined_at");
  spelare = data ?? [];
  ritaSpelare();

  kanal = supabase
    .channel(`lobby-${rum.id}`)
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "quiz_players", filter: `room_id=eq.${rum.id}` },
      (p) => {
        if (spelare.some((s) => s.id === p.new.id)) return;
        spelare.push(p.new);
        ritaSpelare();
      }
    )
    .on(
      "postgres_changes",
      { event: "DELETE", schema: "public", table: "quiz_players" },
      (p) => {
        spelare = spelare.filter((s) => s.id !== p.old.id);
        ritaSpelare();
      }
    )
    .subscribe();

  visa(lobby);
}

async function stangLobby() {
  if (kanal) await supabase.removeChannel(kanal);
  kanal = null;
  rum = null;
  spelare = [];
}

// ---------- Uppstart ----------

async function efterInloggning(user) {
  const oppet = await hittaOppetRum(user.id);
  if (oppet) await oppnaLobby(oppet);
  else visa(start);
}

const { data: { session } } = await supabase.auth.getSession();
if (arVard(session)) await efterInloggning(session.user);
else visa(login);

// ---------- Knappar ----------

document.getElementById("loginform").addEventListener("submit", async (e) => {
  e.preventDefault();
  const { data, error } = await supabase.auth.signInWithPassword({
    email: document.getElementById("epost").value,
    password: document.getElementById("losen").value,
  });
  if (error) {
    document.getElementById("loginfel").textContent = "Fel e-post eller lösenord";
    return;
  }
  await efterInloggning(data.user);
});

document.getElementById("loggaut").addEventListener("click", async () => {
  await supabase.auth.signOut();
  visa(login);
});

document.getElementById("skapa").addEventListener("click", async () => {
  try {
    await oppnaLobby(await skapaRum());
  } catch (err) {
    document.getElementById("startfel").textContent = err.message;
  }
});

document.getElementById("avsluta").addEventListener("click", async () => {
  if (!confirm("Avsluta rummet? Alla spelare kopplas bort.")) return;
  await supabase.from("quiz_rooms").delete().eq("id", rum.id);
  await stangLobby();
  visa(start);
});

document.getElementById("spelarlista").addEventListener("click", async (e) => {
  const knapp = e.target.closest("button.spelare");
  if (!knapp) return;
  if (!confirm(`Ta bort ${knapp.textContent}?`)) return;

  const id = knapp.dataset.id;
  await supabase.from("quiz_players").delete().eq("id", id);
  spelare = spelare.filter((s) => s.id !== id);
  ritaSpelare();
});