import { supabase } from "./supabase.js";
import { sokLatar, hamtaLat, sokBilder, bildUrl } from "./media.js";

const $ = (id) => document.getElementById(id);

const sektioner = {
  login: $("login"),
  lista: $("lista"),
  quiz: $("quiz"),
  fragaform: $("fragaform"),
  konto: $("konto"),
};

let jag = null;             // inloggad användare
let quiz = null;            // frågesporten som redigeras
let fragor = [];            // dess frågor
let redigeradFraga = null;  // frågan i formuläret, null = ny fråga
let valtMedia = null;       // media som är valt i formuläret

let senasteLatar = [];
let senasteBilder = [];
const ljudCache = new Map(); // låt-id → färsk ljudadress
const ljudspelare = new Audio();
let spelarId = null;

function visa(namn) {
  ljudspelare.pause();
  for (const [n, s] of Object.entries(sektioner)) s.hidden = n !== namn;
  window.scrollTo(0, 0);
}

function esc(text) {
  const d = document.createElement("div");
  d.textContent = String(text ?? "");
  return d.innerHTML;
}

function alternativText(a) {
  return typeof a === "string" ? a : a?.text ?? "";
}

// ---------- Inloggning ----------

async function efterInloggning(user) {
  jag = user;

  const { data: profil } = await supabase
    .from("quiz_profiles")
    .select("namn")
    .eq("user_id", user.id)
    .maybeSingle();

  if (!profil) {
    $("kontostatus").textContent =
      "Välj ett visningsnamn. Det syns för andra när de använder dina frågesporter.";
    visa("konto");
    return;
  }

  $("visningsnamn").value = profil.namn;
  await visaLista();
}

// ---------- Listan ----------

async function visaLista() {
  const [{ data: quizzar }, { data: profiler }] = await Promise.all([
    supabase
      .from("quiz_quizzes")
      .select("id, titel, owner_id, quiz_questions(count)")
      .order("titel"),
    supabase.from("quiz_profiles").select("user_id, namn"),
  ]);

  const namn = Object.fromEntries((profiler ?? []).map((p) => [p.user_id, p.namn]));

  const rad = (q, egen) => {
    const antal = q.quiz_questions[0]?.count ?? 0;
    const info = `${antal} ${antal === 1 ? "fråga" : "frågor"}` +
      (egen ? "" : ` · ${esc(namn[q.owner_id] ?? "okänd")}`);

    return `
      <li>
        <div>
          <strong>${esc(q.titel)}</strong>
          <span class="info">${info}</span>
        </div>
        ${egen ? `<button class="liten" data-oppna="${q.id}">Redigera</button>` : ""}
        <button class="liten diskret" data-kopiera="${q.id}">Kopiera</button>
      </li>`;
  };

  const mina = (quizzar ?? []).filter((q) => q.owner_id === jag.id);
  const andras = (quizzar ?? []).filter((q) => q.owner_id !== jag.id);

  $("mina").innerHTML =
    mina.map((q) => rad(q, true)).join("") || `<li class="tom">Inga frågesporter än</li>`;
  $("andras").innerHTML =
    andras.map((q) => rad(q, false)).join("") || `<li class="tom">Inga delade frågesporter</li>`;

  visa("lista");
}

// ---------- En frågesport ----------

async function oppnaQuiz(id) {
  const { data } = await supabase
    .from("quiz_quizzes")
    .select("id, titel, beskrivning")
    .eq("id", id)
    .single();
  quiz = data;

  $("titel").value = quiz.titel;
  $("beskrivning").value = quiz.beskrivning ?? "";
  $("quizstatus").textContent = "";

  await laddaFragor();
  visa("quiz");
}

async function laddaFragor() {
  const { data } = await supabase
    .from("quiz_questions")
    .select("*")
    .eq("quiz_id", quiz.id)
    .order("position");
  fragor = data ?? [];
  ritaFragor();
}

function ritaFragor() {
  $("fragor").innerHTML =
    fragor
      .map((f, i) => {
        const svarInfo =
          f.typ === "nummer"
            ? `Svar: ${esc(f.ratt.svar)} (±${esc(f.ratt.marginal)})`
            : f.alternativ
                .map((a, j) =>
                  j === f.ratt ? `<b>✓ ${esc(alternativText(a))}</b>` : esc(alternativText(a))
                )
                .join(" · ");

        const ikon =
          f.media?.typ === "ljud" ? "🎵 " : f.media?.typ === "bild" ? "🖼 " : "";

        return `
          <li>
            <div class="fraga-info">
              <strong>${ikon}${esc(f.fraga)}</strong>
              <span class="info">${svarInfo} · ${f.tid_sekunder} s</span>
            </div>
            <div class="fraga-knappar">
              <button class="liten diskret" data-upp="${f.id}" ${i === 0 ? "disabled" : ""} aria-label="Flytta upp">↑</button>
              <button class="liten diskret" data-ned="${f.id}" ${i === fragor.length - 1 ? "disabled" : ""} aria-label="Flytta ned">↓</button>
              <button class="liten" data-andra="${f.id}">Ändra</button>
              <button class="liten diskret farlig" data-radera="${f.id}">Radera</button>
            </div>
          </li>`;
      })
      .join("") || `<li class="tom">Inga frågor än</li>`;
}

// ---------- Frågeformuläret ----------

function visaTyp(typ) {
  const nummer = typ === "nummer";
  // Ett inaktiverat fieldset hoppas över av formulärets validering,
  // så "required" i den dolda delen stoppar inte sparandet
  $("alternativfalt").hidden = nummer;
  $("alternativfalt").disabled = nummer;
  $("nummerfalt").hidden = !nummer;
  $("nummerfalt").disabled = !nummer;
}

function visaFlik(namn) {
  $("flikmusik").hidden = namn !== "musik";
  $("flikbild").hidden = namn !== "bild";
}

function oppnaFragaform(f = null) {
  redigeradFraga = f;
  const typ = f?.typ ?? "flerval";

  $("fragaformrubrik").textContent = f ? "Ändra fråga" : "Ny fråga";
  $("fragetyp").value = typ;
  $("fragatext").value = f?.fraga ?? "";
  $("tid").value = f?.tid_sekunder ?? 20;
  visaTyp(typ);

  document.querySelectorAll(".alttext").forEach((t, i) => {
    t.value = f && typ === "flerval" ? alternativText(f.alternativ[i]) : "";
  });
  document.querySelectorAll('input[name="ratt"]').forEach((r, i) => {
    r.checked = f && typ === "flerval" ? i === f.ratt : false;
  });
  $("nummersvar").value = typ === "nummer" ? f.ratt.svar : "";
  $("marginal").value = typ === "nummer" ? f.ratt.marginal : 10;

  valtMedia = f?.media ? { ...f.media } : null;
  $("musiksok").value = "";
  $("bildsok").value = "";
  $("bildurl").value = "";
  $("musikresultat").innerHTML = "";
  $("bildresultat").innerHTML = "";
  visaFlik(null);
  ritaValtMedia();

  $("fragafel").textContent = "";
  visa("fragaform");
  $("fragatext").focus();
}

// ---------- Valt media ----------

function ritaValtMedia() {
  ljudspelare.pause();
  const m = valtMedia;

  if (!m) {
    $("valtmedia").innerHTML = "";
    return;
  }

  if (m.typ === "ljud") {
    $("valtmedia").innerHTML = `
      <div class="valt-kort">
        ${m.bild ? `<img src="${esc(m.bild)}" alt="">` : ""}
        <div class="valt-info">
          <strong>${esc(m.titel)}</strong>
          <span class="info">${esc(m.artist)}${m.ar ? ` · ${esc(m.ar)}` : ""}</span>
          <label class="ljudstart">
            Starta vid sekund
            <input id="ljudstart" type="number" min="0" max="25" value="${m.start ?? 0}">
          </label>
          <div class="valt-knappar">
            <button type="button" class="liten" id="provspela">▶ Provlyssna</button>
            ${m.ar ? `<button type="button" class="liten diskret" id="anvandar">Gör till årtalsfråga</button>` : ""}
            <button type="button" class="liten diskret farlig" id="tabortmedia">Ta bort</button>
          </div>
        </div>
      </div>`;
        uppdateraSpelknappar();
    return;
  }

  const kalla =
    m.kalla === "wikimedia"
      ? `${esc(m.upphov || "Okänd upphovsperson")} · ${esc(m.licens)} · Wikimedia Commons`
      : "Egen bildadress";

  $("valtmedia").innerHTML = `
    <div class="valt-kort">
      <img src="${esc(bildUrl(m, 400))}" alt="">
      <div class="valt-info">
        <span class="info">${kalla}</span>
        <div class="valt-knappar">
          <button type="button" class="liten diskret farlig" id="tabortmedia">Ta bort</button>
        </div>
      </div>
    </div>`;
}

async function spela(id, start = 0) {
  // Samma låt igen medan den spelar = pausa
  if (spelarId === id && !ljudspelare.paused) {
    ljudspelare.pause();
    return;
  }

  let url = ljudCache.get(id);
  if (!url) {
    const lat = await hamtaLat(id);
    url = lat?.ljud;
    if (!url) return alert("Klippet gick inte att hämta");
    ljudCache.set(id, url);
  }

  spelarId = id;
  ljudspelare.src = url;
  ljudspelare.currentTime = start;
  await ljudspelare.play();
}

function uppdateraSpelknappar() {
  const spelar = (id) => spelarId === id && !ljudspelare.paused;

  document.querySelectorAll("[data-spela]").forEach((knapp) => {
    const pa = spelar(knapp.dataset.spela);
    knapp.textContent = pa ? "⏸" : "▶";
    knapp.setAttribute("aria-label", pa ? "Pausa" : "Provlyssna");
  });

  const provspela = $("provspela");
  if (provspela && valtMedia) {
    provspela.textContent = spelar(valtMedia.ref) ? "⏸ Pausa" : "▶ Provlyssna";
  }
}

ljudspelare.addEventListener("play", uppdateraSpelknappar);
ljudspelare.addEventListener("pause", uppdateraSpelknappar);
ljudspelare.addEventListener("ended", uppdateraSpelknappar);

// ---------- Sökning ----------

async function sokMusik() {
  const sok = $("musiksok").value.trim();
  if (!sok) return;
  $("musikresultat").innerHTML = `<li class="tom">Söker …</li>`;

  try {
    senasteLatar = await sokLatar(sok);
    senasteLatar.forEach((l) => ljudCache.set(l.id, l.ljud));

    $("musikresultat").innerHTML =
      senasteLatar
        .map(
          (l) => `
            <li>
              ${l.bild ? `<img src="${esc(l.bild)}" alt="">` : ""}
              <div class="valt-info">
                <strong>${esc(l.titel)}</strong>
                <span class="info">${esc(l.artist)}${l.ar ? ` · ${esc(l.ar)}` : ""}</span>
              </div>
              <button type="button" class="liten diskret" data-spela="${l.id}" aria-label="Provlyssna">▶</button>
              <button type="button" class="liten" data-valj="${l.id}">Välj</button>
            </li>`
        )
        .join("") || `<li class="tom">Inga träffar</li>`;
        uppdateraSpelknappar();
  } catch (err) {
    $("musikresultat").innerHTML = `<li class="tom">${esc(err.message)}</li>`;
  }
}

async function sokBild() {
  const sok = $("bildsok").value.trim();
  if (!sok) return;
  $("bildresultat").innerHTML = `<li class="tom">Söker …</li>`;

  try {
    senasteBilder = await sokBilder(sok);
    $("bildresultat").innerHTML =
      senasteBilder
        .map(
          (b, i) => `
            <li>
              <button type="button" data-bild="${i}" title="${esc(b.upphov)}">
                <img src="${esc(b.tumnagel)}" alt="" loading="lazy">
              </button>
            </li>`
        )
        .join("") || `<li class="tom">Inga träffar</li>`;
  } catch (err) {
    $("bildresultat").innerHTML = `<li class="tom">${esc(err.message)}</li>`;
  }
}

// Enter i en sökruta ska söka, inte skicka hela frågeformuläret
function sokVidEnter(falt, funktion) {
  $(falt).addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    funktion();
  });
}

// ---------- Uppstart ----------

const { data: { session } } = await supabase.auth.getSession();
if (session && !session.user.is_anonymous) await efterInloggning(session.user);
else visa("login");

// ---------- Knappar och formulär ----------

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

$("nyquiz").addEventListener("click", async () => {
  const { data, error } = await supabase
    .from("quiz_quizzes")
    .insert({ titel: "Ny frågesport" })
    .select("id")
    .single();
  if (error) return alert(error.message);

  await oppnaQuiz(data.id);
  $("titel").select();
});

$("lista").addEventListener("click", async (e) => {
  const oppna = e.target.closest("[data-oppna]");
  const kopiera = e.target.closest("[data-kopiera]");

  if (oppna) await oppnaQuiz(oppna.dataset.oppna);

  if (kopiera) {
    const { data: nyttId, error } = await supabase.rpc("quiz_kopiera", {
      p_quiz: kopiera.dataset.kopiera,
    });
    if (error) return alert(error.message);
    await oppnaQuiz(nyttId);
  }
});

$("tillbaka").addEventListener("click", visaLista);

$("quizform").addEventListener("submit", async (e) => {
  e.preventDefault();
  const { error } = await supabase
    .from("quiz_quizzes")
    .update({
      titel: $("titel").value.trim(),
      beskrivning: $("beskrivning").value.trim() || null,
    })
    .eq("id", quiz.id);
  $("quizstatus").textContent = error ? error.message : "Sparat";
});

$("raderaquiz").addEventListener("click", async () => {
  if (!confirm(`Radera "${quiz.titel}" och alla dess frågor? Det går inte att ångra.`)) return;
  await supabase.from("quiz_quizzes").delete().eq("id", quiz.id);
  await visaLista();
});

$("nyfraga").addEventListener("click", () => oppnaFragaform());

$("fragor").addEventListener("click", async (e) => {
  const knapp = e.target.closest("button");
  if (!knapp) return;
  const { upp, ned, andra, radera } = knapp.dataset;

  if (upp || ned) {
    await supabase.rpc("quiz_flytta_fraga", { p_fraga: upp ?? ned, p_steg: upp ? -1 : 1 });
    await laddaFragor();
  }

  if (andra) oppnaFragaform(fragor.find((f) => f.id === andra));

  if (radera) {
    if (!confirm("Radera frågan?")) return;
    await supabase.from("quiz_questions").delete().eq("id", radera);
    await laddaFragor();
  }
});

$("fragetyp").addEventListener("change", (e) => visaTyp(e.target.value));

document.querySelector(".mediaflikar").addEventListener("click", (e) => {
  const flik = e.target.closest("[data-flik]")?.dataset.flik;
  if (!flik) return;

  if (flik === "ingen") {
    valtMedia = null;
    ritaValtMedia();
    visaFlik(null);
    return;
  }

  visaFlik(flik);
  $(flik === "musik" ? "musiksok" : "bildsok").focus();
});

sokVidEnter("musiksok", sokMusik);
sokVidEnter("bildsok", sokBild);
$("musiksokknapp").addEventListener("click", sokMusik);
$("bildsokknapp").addEventListener("click", sokBild);

$("musikresultat").addEventListener("click", async (e) => {
  const knapp = e.target.closest("button");
  if (!knapp) return;

  if (knapp.dataset.spela) await spela(knapp.dataset.spela);

  if (knapp.dataset.valj) {
    const l = senasteLatar.find((x) => x.id === knapp.dataset.valj);
    valtMedia = {
      typ: "ljud",
      kalla: "itunes",
      ref: l.id,
      start: 0,
      titel: l.titel,
      artist: l.artist,
      ar: l.ar,
      bild: l.bild,
    };
    visaFlik(null);
    ritaValtMedia();
  }
});

$("bildresultat").addEventListener("click", (e) => {
  const knapp = e.target.closest("[data-bild]");
  if (!knapp) return;

  const b = senasteBilder[Number(knapp.dataset.bild)];
  valtMedia = {
    typ: "bild",
    kalla: "wikimedia",
    ref: b.ref,
    upphov: b.upphov,
    licens: b.licens,
  };
  visaFlik(null);
  ritaValtMedia();
});

$("bildurlknapp").addEventListener("click", () => {
  const url = $("bildurl").value.trim();
  if (!url.startsWith("https://")) return alert("Adressen måste börja med https://");
  valtMedia = { typ: "bild", kalla: "url", ref: url };
  visaFlik(null);
  ritaValtMedia();
});

$("valtmedia").addEventListener("click", async (e) => {
  const id = e.target.closest("button")?.id;

  if (id === "tabortmedia") {
    valtMedia = null;
    ritaValtMedia();
  }

  if (id === "provspela") await spela(valtMedia.ref, valtMedia.start ?? 0);

  if (id === "anvandar") {
    $("fragetyp").value = "nummer";
    visaTyp("nummer");
    $("nummersvar").value = valtMedia.ar;
    if (!$("fragatext").value.trim()) $("fragatext").value = "Vilket år kom den här låten?";
    $("nummersvar").focus();
  }
});

$("valtmedia").addEventListener("input", (e) => {
  if (e.target.id !== "ljudstart") return;
  valtMedia.start = Math.min(25, Math.max(0, Number(e.target.value) || 0));
});

$("fragaformular").addEventListener("submit", async (e) => {
  e.preventDefault();
  const fel = (text) => ($("fragafel").textContent = text);
  const typ = $("fragetyp").value;

  const rad = {
    typ,
    fraga: $("fragatext").value.trim(),
    tid_sekunder: Number($("tid").value),
    media: valtMedia,
  };

  if (typ === "nummer") {
    rad.alternativ = [];
    rad.ratt = {
      svar: Number($("nummersvar").value),
      marginal: Number($("marginal").value),
    };
  } else {
    const texter = [...document.querySelectorAll(".alttext")].map((t) => t.value.trim());
    const valt = Number(document.querySelector('input[name="ratt"]:checked').value);

    if (!texter[valt]) return fel("Det rätta alternativet saknar text");

    // Hoppa över tomma alternativ, men håll reda på vilket som är rätt
    const ifyllda = texter
      .map((text, i) => ({ text, i }))
      .filter((a) => a.text);
    if (ifyllda.length < 2) return fel("Fyll i minst två alternativ");

    rad.alternativ = ifyllda.map((a) => a.text);
    rad.ratt = ifyllda.findIndex((a) => a.i === valt);
  }

  let error;
  if (redigeradFraga) {
    ({ error } = await supabase
      .from("quiz_questions")
      .update(rad)
      .eq("id", redigeradFraga.id));
  } else {
    const position = Math.max(0, ...fragor.map((f) => f.position)) + 1;
    ({ error } = await supabase
      .from("quiz_questions")
      .insert({ ...rad, quiz_id: quiz.id, position }));
  }
  if (error) return fel(error.message);

  await laddaFragor();
  visa("quiz");
});

$("avbrytfraga").addEventListener("click", () => visa("quiz"));

// ---------- Konto ----------

$("tillkonto").addEventListener("click", () => {
  $("kontostatus").textContent = "";
  visa("konto");
});

$("kontotillbaka").addEventListener("click", visaLista);

$("namnform").addEventListener("submit", async (e) => {
  e.preventDefault();
  const { error } = await supabase
    .from("quiz_profiles")
    .upsert({ user_id: jag.id, namn: $("visningsnamn").value.trim() });
  $("kontostatus").textContent = error ? error.message : "Namnet är sparat";
});

$("losenform").addEventListener("submit", async (e) => {
  e.preventDefault();
  const { error } = await supabase.auth.updateUser({ password: $("nyttlosen").value });
  $("kontostatus").textContent = error ? error.message : "Lösenordet är bytt";
  if (!error) $("nyttlosen").value = "";
});

$("loggaut").addEventListener("click", async () => {
  await supabase.auth.signOut();
  visa("login");
});