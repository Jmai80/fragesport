import { supabase } from "./supabase.js";
import QRCode from "https://esm.sh/qrcode@1";

const $ = (id) => document.getElementById(id);

const sektioner = {
  login: $("login"),
  start: $("start"),
  lobby: $("lobby"),
  spel: $("spel"),
  slut: $("slut"),
};

const FARGER = ["rod", "bla", "gul", "gron"];
const SYMBOLER = ["▲", "◆", "●", "■"];

let rum = null;      // rummets rad, uppdateras via realtid
let spelare = [];
let kanal = null;
let fraga = null;    // aktuell fråga från quiz_aktuell_fraga
let svar = [];       // inkomna svar på aktuell fråga
let timer = null;

function visa(namn) {
  for (const [n, s] of Object.entries(sektioner)) s.hidden = n !== namn;
}

function arVard(session) {
  return session && !session.user.is_anonymous;
}

function esc(text) {
  const d = document.createElement("div");
  d.textContent = String(text ?? "");
  return d.innerHTML;
}

// Ett alternativ är en text i dag, men kan bli ett objekt med bild senare
function alternativText(a) {
  return typeof a === "string" ? a : a.text ?? "";
}

// ---------- Rum ----------

async function skapaRum() {
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

async function oppnaRum(nyttRum) {
  rum = nyttRum;

  // Anslutningsinfo och QR-kod
  const adress = new URL("./", location.href);
  $("adress").textContent = adress.host + adress.pathname;
  $("kod").textContent = rum.code;
  const lank = new URL(`./?kod=${rum.code}`, location.href).href;
  $("qr").innerHTML = await QRCode.toString(lank, {
    type: "svg",
    margin: 1,
    color: { dark: "#1c1917", light: "#ffffff" },
  });

  // Spelare och frågesporter
  const { data: sp } = await supabase
    .from("quiz_players")
    .select("id, nickname")
    .eq("room_id", rum.id)
    .order("joined_at");
  spelare = sp ?? [];

  const [{ data: quizzar }, { data: profiler }] = await Promise.all([
    supabase.from("quiz_quizzes").select("id, titel, owner_id").order("titel"),
    supabase.from("quiz_profiles").select("user_id, namn"),
  ]);

  const namn = Object.fromEntries((profiler ?? []).map((p) => [p.user_id, p.namn]));
  const mina = (quizzar ?? []).filter((q) => q.owner_id === rum.host_id);
  const andras = (quizzar ?? []).filter((q) => q.owner_id !== rum.host_id);

  const alternativ = (q, visaSkapare) =>
    `<option value="${q.id}">${esc(q.titel)}${
      visaSkapare ? ` (${esc(namn[q.owner_id] ?? "okänd")})` : ""
    }</option>`;

  $("quizval").innerHTML =
    `<optgroup label="Mina">${mina.map((q) => alternativ(q, false)).join("")}</optgroup>` +
    (andras.length
      ? `<optgroup label="Andras">${andras.map((q) => alternativ(q, true)).join("")}</optgroup>`
      : "");

  // En kanal för allt som händer i rummet
  kanal = supabase
    .channel(`rum-${rum.id}`)
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
    .on(
      "postgres_changes",
      { event: "UPDATE", schema: "public", table: "quiz_rooms", filter: `id=eq.${rum.id}` },
      (p) => {
        rum = p.new;
        rendera();
      }
    )
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "quiz_answers", filter: `room_id=eq.${rum.id}` },
      (p) => {
        if (p.new.fraga_nr !== rum.fraga_nr) return;
        svar.push(p.new);
        ritaSvarsantal();
      }
    )
    .subscribe();

  await rendera();
}

async function stangRum() {
  clearInterval(timer);
  if (kanal) await supabase.removeChannel(kanal);
  kanal = null;
  rum = null;
  spelare = [];
  fraga = null;
  svar = [];
}

// ---------- Rendering ----------

async function rendera() {
  clearInterval(timer);

  if (rum.status === "lobby") {
    ritaSpelare();
    visa("lobby");
    return;
  }

  if (rum.status === "slut") {
    const { data: res } = await supabase.rpc("quiz_resultat", { p_rum: rum.id });
    $("slutlista").innerHTML = topplistaHtml(res?.topplista ?? []);
    visa("slut");
    return;
  }

  // Läget är "fraga" eller "facit"
  const { data } = await supabase.rpc("quiz_aktuell_fraga", { p_rum: rum.id });
  fraga = data;

  const { data: inkomna } = await supabase
    .from("quiz_answers")
    .select("svar")
    .eq("room_id", rum.id)
    .eq("fraga_nr", rum.fraga_nr);
  svar = inkomna ?? [];

  const facit = rum.status === "facit";

  $("fragenr").textContent = `Fråga ${fraga.nr} av ${fraga.antal}`;
  $("fragetext").textContent = fraga.fraga;
  $("nedrakning").hidden = facit;
  $("visafacit").hidden = facit;
  $("facitdel").hidden = !facit;
  ritaAlternativ();
  ritaSvarsantal();

  if (facit) {
    const { data: res } = await supabase.rpc("quiz_resultat", { p_rum: rum.id });
    $("topplista").innerHTML = topplistaHtml((res?.topplista ?? []).slice(0, 5));
    $("nasta").textContent = fraga.nr === fraga.antal ? "Visa resultat" : "Nästa fråga";
  } else {
    startaNedrakning(fraga.kvar_ms);
  }

  visa("spel");
}

function ritaSpelare() {
  $("antal").textContent =
    spelare.length === 1 ? "1 spelare" : `${spelare.length} spelare`;

  $("spelarlista").innerHTML = spelare
    .map(
      (s) =>
        `<li><button class="spelare" data-id="${s.id}" title="Klicka för att ta bort">${esc(s.nickname)}</button></li>`
    )
    .join("");
}

function ritaAlternativ() {
  const facit = rum.status === "facit";

  $("alternativ").innerHTML = fraga.alternativ
    .map((a, i) => {
      const klasser = [FARGER[i % 4]];
      if (facit) klasser.push(i === fraga.ratt ? "ratt-alt" : "fel-alt");
      const antal = svar.filter((s) => s.svar === i).length;

      return `
        <li class="${klasser.join(" ")}">
          <span class="symbol">${SYMBOLER[i % 4]}</span>
          <span class="alt-text">${esc(alternativText(a))}</span>
          ${facit ? `<span class="alt-antal">${antal}</span>` : ""}
        </li>`;
    })
    .join("");
}

function ritaSvarsantal() {
  $("svarsantal").textContent = `${svar.length} av ${spelare.length} svar`;

  // Alla har svarat: visa facit direkt i stället för att vänta ut tiden
  if (rum.status === "fraga" && spelare.length > 0 && svar.length >= spelare.length) {
    visaFacit();
  }
}

function topplistaHtml(lista) {
  return lista
    .map(
      (p) => `
        <li>
          <span class="placering">${p.placering}</span>
          <span class="namn">${esc(p.namn)}</span>
          <span class="poang">${p.poang}</span>
        </li>`
    )
    .join("");
}

function startaNedrakning(ms) {
  const slut = Date.now() + ms;

  const tick = () => {
    const kvar = Math.max(0, Math.ceil((slut - Date.now()) / 1000));
    $("nedrakning").textContent = kvar;
    if (kvar === 0) {
      clearInterval(timer);
      visaFacit();
    }
  };

  tick();
  timer = setInterval(tick, 250);
}

async function visaFacit() {
  if (rum?.status !== "fraga") return;
  await supabase.rpc("quiz_facit", { p_rum: rum.id });
}

// ---------- Uppstart ----------

async function efterInloggning(user) {
  const oppet = await hittaOppetRum(user.id);
  if (oppet) await oppnaRum(oppet);
  else visa("start");
}

const { data: { session } } = await supabase.auth.getSession();
if (arVard(session)) await efterInloggning(session.user);
else visa("login");

// ---------- Knappar ----------

$("loginform").addEventListener("submit", async (e) => {
  e.preventDefault();
  const { data, error } = await supabase.auth.signInWithPassword({
    email: $("epost").value,
    password: $("losen").value,
  });
  if (error) {
    $("loginfel").textContent = "Fel e-post eller lösenord";
    return;
  }
  await efterInloggning(data.user);
});

$("loggaut").addEventListener("click", async () => {
  await supabase.auth.signOut();
  visa("login");
});

$("skapa").addEventListener("click", async () => {
  try {
    await oppnaRum(await skapaRum());
  } catch (err) {
    $("startfel").textContent = err.message;
  }
});

$("starta").addEventListener("click", async () => {
  $("lobbyfel").textContent = "";
  const { error } = await supabase.rpc("quiz_starta", {
    p_rum: rum.id,
    p_quiz: $("quizval").value,
  });
  if (error) $("lobbyfel").textContent = error.message;
});

$("visafacit").addEventListener("click", visaFacit);

$("nasta").addEventListener("click", async () => {
  await supabase.rpc("quiz_nasta", { p_rum: rum.id });
});

async function avslutaRum() {
  await supabase.from("quiz_rooms").delete().eq("id", rum.id);
  await stangRum();
  visa("start");
}

$("avsluta").addEventListener("click", async () => {
  if (!confirm("Avsluta rummet? Alla spelare kopplas bort.")) return;
  await avslutaRum();
});

$("klar").addEventListener("click", avslutaRum);

$("spelarlista").addEventListener("click", async (e) => {
  const knapp = e.target.closest("button.spelare");
  if (!knapp) return;
  if (!confirm(`Ta bort ${knapp.textContent}?`)) return;

  const id = knapp.dataset.id;
  await supabase.from("quiz_players").delete().eq("id", id);
  spelare = spelare.filter((s) => s.id !== id);
  ritaSpelare();
});