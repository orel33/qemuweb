// The About dialog, opened by the button of the header on the main page and on /admin.

// The version of package.json (checked by a unit test: update both at a release).
export const VERSION = '0.9.9';
const REPOSITORY = 'https://github.com/orel33/qemuweb';
const AUTHOR = 'aurelien.esnard@u-bordeaux.fr';

const MARKUP = `
  <form method="dialog">
    <div class="settings-heading"><h2 id="about-title">QemuWeb <span class="about-version">${VERSION}</span></h2></div>
    <div class="about-body">
      <p>Open source, MIT License.</p>
      <p>Source code: <a href="${REPOSITORY}" target="_blank" rel="noopener noreferrer">${REPOSITORY}</a></p>
      <p>Designed by <a href="mailto:${AUTHOR}">${AUTHOR}</a></p>
      <p>Co-authored with Claude and Codex</p>
    </div>
    <div class="create-actions"><button type="submit">Close</button></div>
  </form>`;

let dialog = null;

function openAbout() {
  if (!dialog) {
    dialog = document.createElement('dialog');
    dialog.className = 'qemu-options create-dialog';
    dialog.setAttribute('aria-labelledby', 'about-title');
    dialog.innerHTML = MARKUP;
    document.body.append(dialog);
  }
  dialog.showModal();
}

export function initAbout() {
  document.getElementById('show-about').addEventListener('click', openAbout);
}
