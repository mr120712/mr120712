// @polsia:user-owned — indizio «questo dispositivo ha una sessione di Solco», solo per evitare che
// la landing pubblica di "/" lampeggi a chi ha già fatto l'accesso. NON è un controllo di sicurezza:
// la sessione vera la verifica better-auth. require-login.tsx lo scrive in localStorage quando la
// sessione è nota; head-content.tsx lo legge con SIGNED_IN_HINT_SCRIPT prima del primo disegno e
// segna <html> con SIGNED_IN_HINT_ATTRIBUTE (vedi custom-style.css). Modulo normale (non
// 'use client'): lo importano sia il layout del server sia i componenti client.
export const SIGNED_IN_HINT_KEY = 'solco:signed-in';
export const SIGNED_IN_HINT_ATTRIBUTE = 'data-solco-signed-in';

/** Script in linea (con il nonce della CSP) che segna <html> se c'è l'indizio; mai un errore. */
export const SIGNED_IN_HINT_SCRIPT = `try{if(localStorage.getItem(${JSON.stringify(SIGNED_IN_HINT_KEY)})==='1')document.documentElement.setAttribute(${JSON.stringify(SIGNED_IN_HINT_ATTRIBUTE)},'')}catch(e){}`;
