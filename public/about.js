// The About dialog, opened by the button of the header on the main page and on /admin: the logo makes a show of
// its entrance and bursts into confetti (again on each click on it). Nothing moves with reduced motion.

// The version of package.json (checked by a unit test: update both at a release).
export const VERSION = '0.9.9';
const REPOSITORY = 'https://github.com/orel33/qemuweb';
const AUTHOR = 'aurelien.esnard@u-bordeaux.fr';

const LOGO = '/favicon.svg';
// The address of the main page that opens the dialog: /#about (login.js keeps it through the login).
const LINK = '#about';
const COLORS = ['#5adbd1', '#ffc36b', '#ff6fae', '#9ee6b4', '#9fc5ef', '#c99bff', '#fff27a'];

const MARKUP = `
  <form method="dialog" class="about-form">
    <div class="about-confetti" aria-hidden="true"></div>
    <div class="settings-heading"><h2 id="about-title"><span class="about-name">QemuWeb</span> <span class="about-version">${VERSION}</span></h2></div>
    <div class="about-stage">
      <span class="about-rays" aria-hidden="true"></span>
      <button type="button" class="about-logo" title="More confetti!" aria-label="More confetti"><img src="${LOGO}" width="112" height="112" alt=""></button>
    </div>
    <div class="about-body">
      <p>Open source, MIT License.</p>
      <p>Source code: <a href="${REPOSITORY}" target="_blank" rel="noopener noreferrer">${REPOSITORY}</a></p>
      <p>Designed by <a href="mailto:${AUTHOR}">${AUTHOR}</a></p>
      <p>Co-authored with Claude and Codex</p>
    </div>
    <div class="create-actions"><button type="submit">Close</button></div>
  </form>`;

// The pieces of one burst, thrown from the logo: where each one peaks, where it lands and how it spins.
// Every fourth piece is a small logo, the others are coloured paper.
export function confettiPieces(count, random = Math.random) {
  return Array.from({length: count}, (_, index) => {
    const x = (random() - 0.5) * 460;
    return {
      logo: index % 4 === 0,
      color: COLORS[index % COLORS.length],
      size: 6 + random() * 8,
      round: index % 3 === 0,
      peak: {x: x * 0.65, y: -40 - random() * 130},
      end: {x, y: 170 + random() * 220},
      spin: (random() - 0.5) * 1440,
      duration: 1500 + random() * 1300,
      delay: random() * 160
    };
  });
}

const stillPlease = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function burst(dialog, count) {
  if (stillPlease()) return;
  const layer = dialog.querySelector('.about-confetti');
  const box = layer.getBoundingClientRect(), logo = dialog.querySelector('.about-logo').getBoundingClientRect();
  const left = logo.left + logo.width / 2 - box.left, top = logo.top + logo.height / 2 - box.top;
  for (const piece of confettiPieces(count)) {
    const element = document.createElement(piece.logo ? 'img' : 'i');
    if (piece.logo) { element.src = LOGO; element.alt = ''; }
    else { element.style.background = piece.color; element.style.borderRadius = piece.round ? '50%' : '2px'; }
    const width = piece.logo ? piece.size * 2.4 : piece.size;
    Object.assign(element.style, {left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${piece.logo || piece.round ? width : width * 0.55}px`});
    layer.append(element);
    const at = ({x, y}, turn, scale) => `translate(-50%, -50%) translate(${x}px, ${y}px) rotate(${turn}deg) scale(${scale})`;
    element.animate([
      {transform: at({x: 0, y: 0}, 0, 0.2), opacity: 1, easing: 'cubic-bezier(.15,.7,.4,1)'},
      {transform: at(piece.peak, piece.spin * 0.4, 1.15), opacity: 1, offset: 0.35, easing: 'cubic-bezier(.45,0,.9,.6)'},
      {transform: at(piece.end, piece.spin, 0.85), opacity: 0}
    ], {duration: piece.duration, delay: piece.delay, fill: 'both'}).finished.then(() => element.remove(), () => element.remove());
  }
}

let dialog = null, secondWave = 0;

function openAbout() {
  if (!dialog) {
    dialog = document.createElement('dialog');
    dialog.className = 'qemu-options create-dialog about-dialog';
    dialog.setAttribute('aria-labelledby', 'about-title');
    dialog.innerHTML = MARKUP;
    document.body.append(dialog);
    dialog.querySelector('.about-logo').addEventListener('click', () => burst(dialog, 60));
    dialog.addEventListener('close', () => {
      // The link is used up: a reload does not open the dialog again, and the same link works once more.
      if (location.hash === LINK) history.replaceState(null, '', location.pathname + location.search);
      clearTimeout(secondWave);
      dialog.querySelector('.about-confetti').replaceChildren();
    });
  }
  if (dialog.open) return;
  dialog.showModal();
  // Two waves, timed on the landing of the logo.
  secondWave = setTimeout(() => {
    burst(dialog, 90);
    secondWave = setTimeout(() => burst(dialog, 45), 700);
  }, 450);
}

export function initAbout() {
  document.getElementById('show-about').addEventListener('click', openAbout);
}

// Main page only (/admin uses the fragment for its tabs): opens the dialog for /#about, at load or later.
export function watchAboutLink() {
  const follow = () => { if (location.hash === LINK) openAbout(); };
  window.addEventListener('hashchange', follow);
  follow();
}
