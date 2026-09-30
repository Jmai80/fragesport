import { supabase } from "./supabase.js";

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

function visa(namn) {
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
        const alternativ = f.alternativ
          .map((a, j) =>
            j === f.ratt ? `<b>✓ ${esc(alternativText(a))}</b>` : esc(alternativText(a))
          )
          .join(" · ");

        return `
          <li>
            <div class="fraga-info">
              <strong>${esc(f.fraga)}</strong>
              <span class="info">${alternativ} · ${f.tid_sekunder} s</span>
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

function oppnaFragaform(f = null) {
  redigeradFraga = f;
  $("fragaformrubrik").textContent = f ? "Ändra fråga" : "Ny fråga";
  $("fragatext").value = f?.fraga ?? "";
  $("tid").value = f?.tid_sekunder ?? 20;

  document.querySelectorAll(".alttext").forEach((t, i) => {
    t.value = f ? alternativText(f.alternativ[i]) : "";
  });
  document.querySelectorAll('input[name="ratt"]').forEach((r, i) => {
    r.checked = f ? i === f.ratt : false;
  });

  $("fragafel").textContent = "";
  visa("fragaform");
  $("fragatext").focus();
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

$("fragaformular").addEventListener("submit", async (e) => {
  e.preventDefault();
  const fel = (text) => ($("fragafel").textContent = text);

  const texter = [...document.querySelectorAll(".alttext")].map((t) => t.value.trim());
  const valt = Number(document.querySelector('input[name="ratt"]:checked').value);

  if (!texter[valt]) return fel("Det rätta alternativet saknar text");

  // Hoppa över tomma alternativ, men håll reda på vilket som är rätt
  const ifyllda = texter
    .map((text, i) => ({ text, i }))
    .filter((a) => a.text);
  if (ifyllda.length < 2) return fel("Fyll i minst två alternativ");

  const rad = {
    fraga: $("fragatext").value.trim(),
    alternativ: ifyllda.map((a) => a.text),
    ratt: ifyllda.findIndex((a) => a.i === valt),
    tid_sekunder: Number($("tid").value),
  };

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