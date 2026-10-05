// Egna dialogrutor i stället för webbläsarens alert() och confirm().
// Webbläsaren kan blockera sina egna rutor, men aldrig de här.

let dialog = null;

function skapa() {
  dialog = document.createElement("dialog");
  dialog.className = "ruta";
  dialog.innerHTML = `
    <form method="dialog">
      <p class="ruta-text"></p>
      <div class="ruta-knappar">
        <button value="nej" class="diskret ruta-avbryt">Avbryt</button>
        <button value="ja" class="ruta-ok">OK</button>
      </div>
    </form>`;
  document.body.append(dialog);
}

function visaRuta(text, { ok = "OK", avbryt = null, farlig = false } = {}) {
  if (!dialog) skapa();

  const okKnapp = dialog.querySelector(".ruta-ok");
  const avbrytKnapp = dialog.querySelector(".ruta-avbryt");

  dialog.querySelector(".ruta-text").textContent = text;
  okKnapp.textContent = ok;
  okKnapp.classList.toggle("farlig-knapp", farlig);
  avbrytKnapp.hidden = !avbryt;
  if (avbryt) avbrytKnapp.textContent = avbryt;

  dialog.returnValue = "";
  dialog.showModal();

  // Vid farliga val hamnar markören på Avbryt, så att Enter inte raderar något
  (avbryt ? avbrytKnapp : okKnapp).focus();

  return new Promise((resolve) => {
    dialog.addEventListener("close", () => resolve(dialog.returnValue === "ja"), { once: true });
  });
}

// Fråga och vänta på svar: true om användaren bekräftar, annars false
export function bekrafta(text, { ok = "OK", avbryt = "Avbryt", farlig = false } = {}) {
  return visaRuta(text, { ok, avbryt, farlig });
}

// Visa ett meddelande med en OK-knapp
export function meddela(text) {
  return visaRuta(text);
}