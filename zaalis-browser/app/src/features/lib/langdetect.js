'use strict';
// Détection de langue maison, sans dépendance :
//  1. écritures non latines reconnues par plages Unicode (ja, zh, ko, ar, ru,
//     el, he, th, hi…) ;
//  2. langues latines départagées par des mots-outils très fréquents et
//     quelques lettres caractéristiques (ñ, ß, ç, ã, ł, ğ…).
// Renvoie { lang: 'fr', confidence: 0..1 } ou { lang: '', confidence: 0 }.

const NAMES = {
  fr: 'français', en: 'anglais', es: 'espagnol', de: 'allemand', it: 'italien', pt: 'portugais',
  nl: 'néerlandais', pl: 'polonais', ru: 'russe', ja: 'japonais', zh: 'chinois', ko: 'coréen',
  ar: 'arabe', tr: 'turc', sv: 'suédois', da: 'danois', no: 'norvégien', fi: 'finnois', cs: 'tchèque',
  ro: 'roumain', hu: 'hongrois', el: 'grec', he: 'hébreu', uk: 'ukrainien', hi: 'hindi', th: 'thaï',
  vi: 'vietnamien', id: 'indonésien',
};

const STOP = {
  fr: 'le la les de des du un une et est en que qui dans pour pas sur au aux avec ce cette il elle nous vous ils sont ont été par plus mais ou comme son sa ses leur être fait tout aussi très',
  en: 'the of and to in is that for it with as was on are be this by at from have or an not they which you his her has but we their were been can will would there what all one about',
  es: 'el la los las de del que y en un una es por con para no se su al lo como más pero sus le ya o este esta son está muy también fue ha sido entre cuando',
  de: 'der die das und ist nicht ein eine zu den von mit sich des auf für im dem auch es an werden aus er hat dass sie nach wird bei einer um am sind noch wie über',
  it: 'il di che e la per un una in non sono del della le dei gli con si da al è anche come più ma alla nel questo questa ha essere loro quando molto',
  pt: 'o a os as de do da dos das que e em um uma para com não por se na no mais como mas ao sua seu foi são está também muito pelo pela isso',
  nl: 'de het een en van in is dat op te zijn voor met die niet aan er maar om ook als bij dan of uit nog wel worden heeft deze wordt naar hebben',
  pl: 'i w na z się nie do że to jest o jak po co ale tak od za przez dla jego są być tylko może już jej czy przy jako lub',
  tr: 've bir bu da de için ile çok daha ne gibi ama olarak var olan en kadar sonra ya her şey değil mi o ben sen biz onlar',
  sv: 'och att det som en på är av för med till den inte har de om ett var jag men från vid så kan',
  da: 'og i at det er en til på som de med for af ikke den har et han var men fra kan',
  no: 'og i det er som en på til å av for med har ikke den de var jeg et men fra',
  ro: 'și de la în cu pe că nu o un este din pentru care mai sau ca se sunt fost',
  cs: 'a v se na je že to s z do jako pro ale by jsem si jsou o k tak',
  vi: 'và của là có trong cho được với không một những các này người đã',
  id: 'dan yang di ke dari ini itu untuk dengan tidak ada akan dalam pada juga adalah',
};
const MARKS = {
  es: /[ñ¿¡]/g, de: /[ßäöü]/g, fr: /[àâçèéêëîïôœùûü]/g, pt: /[ãõç]/g, pl: /[łąęśźżńć]/g,
  tr: /[ğşıİ]/g, it: /[àèéìòù]/g, ro: /[ăâîșț]/g, cs: /[ěščřžůý]/g, vi: /[ơưđạảấầẩẫậắằẳẵặ]/g,
  sv: /[åäö]/g, da: /[æøå]/g, no: /[æøå]/g,
};
const STOPSETS = Object.fromEntries(Object.entries(STOP).map(([k, v]) => [k, new Set(v.split(' '))]));

function scriptCounts(text) {
  const c = { latin: 0, han: 0, kana: 0, hangul: 0, arabic: 0, cyrillic: 0, greek: 0, hebrew: 0, devanagari: 0, thai: 0 };
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if ((cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a) || (cp >= 0xc0 && cp <= 0x24f) || (cp >= 0x1e00 && cp <= 0x1eff)) c.latin++;
    else if (cp >= 0x3040 && cp <= 0x30ff) c.kana++;
    else if ((cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0x3400 && cp <= 0x4dbf)) c.han++;
    else if ((cp >= 0xac00 && cp <= 0xd7af) || (cp >= 0x1100 && cp <= 0x11ff)) c.hangul++;
    else if (cp >= 0x0600 && cp <= 0x06ff) c.arabic++;
    else if (cp >= 0x0400 && cp <= 0x04ff) c.cyrillic++;
    else if (cp >= 0x0370 && cp <= 0x03ff) c.greek++;
    else if (cp >= 0x0590 && cp <= 0x05ff) c.hebrew++;
    else if (cp >= 0x0900 && cp <= 0x097f) c.devanagari++;
    else if (cp >= 0x0e00 && cp <= 0x0e7f) c.thai++;
  }
  return c;
}

function detect(text) {
  text = String(text || '').slice(0, 20000);
  const c = scriptCounts(text);
  const total = Object.values(c).reduce((a, b) => a + b, 0);
  if (total < 12) return { lang: '', confidence: 0 };
  const share = (n) => n / total;
  if (share(c.kana) > 0.05) return { lang: 'ja', confidence: Math.min(1, 0.6 + share(c.kana + c.han)) };
  if (share(c.hangul) > 0.3) return { lang: 'ko', confidence: Math.min(1, 0.5 + share(c.hangul)) };
  if (share(c.han) > 0.3) return { lang: 'zh', confidence: Math.min(1, 0.5 + share(c.han)) };
  if (share(c.arabic) > 0.3) return { lang: 'ar', confidence: Math.min(1, 0.5 + share(c.arabic)) };
  if (share(c.greek) > 0.3) return { lang: 'el', confidence: 0.9 };
  if (share(c.hebrew) > 0.3) return { lang: 'he', confidence: 0.9 };
  if (share(c.devanagari) > 0.3) return { lang: 'hi', confidence: 0.85 };
  if (share(c.thai) > 0.3) return { lang: 'th', confidence: 0.9 };
  if (share(c.cyrillic) > 0.3) {
    // Ukrainien : lettres absentes du russe.
    const uk = (text.match(/[іїєґІЇЄҐ]/g) || []).length;
    return { lang: uk > 3 ? 'uk' : 'ru', confidence: 0.85 };
  }
  // Langues latines : mots-outils + lettres caractéristiques.
  const words = text.toLowerCase().match(/[a-zà-ÿœæßğşıłąęśźżńćěščřžůơưđ]+/g) || [];
  if (words.length < 4) return { lang: '', confidence: 0 };
  const lower = text.toLowerCase();
  const scores = {};
  for (const [lang, set] of Object.entries(STOPSETS)) {
    let s = 0;
    for (const w of words) if (set.has(w)) s++;
    scores[lang] = s / words.length;
    if (MARKS[lang]) scores[lang] += Math.min(0.12, ((lower.match(MARKS[lang]) || []).length / Math.max(1, lower.length)) * 4);
  }
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const [best, s1] = ranked[0];
  const s2 = ranked[1] ? ranked[1][1] : 0;
  if (s1 < 0.04) return { lang: '', confidence: 0 };
  const confidence = Math.max(0, Math.min(1, (s1 - s2) / s1 + Math.min(0.4, words.length / 200)));
  return { lang: best, confidence: Math.round(confidence * 100) / 100 };
}

// Normalise un code (« fr-FR », « en_US », « zh-Hans ») vers deux lettres.
function normalize(code) {
  const m = /^([a-z]{2,3})/i.exec(String(code || '').trim());
  return m ? m[1].toLowerCase() : '';
}
function langName(code) { return NAMES[normalize(code)] || code || 'langue inconnue'; }

module.exports = { detect, normalize, langName, NAMES };
