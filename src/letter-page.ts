import './styles/base.css';
import './styles/letter.css';

import { initLetter } from './letter';

initLetter();

const year = document.querySelector<HTMLElement>('[data-el="year"]');
if (year) year.textContent = String(new Date().getFullYear());

// Same press feedback as the main site, without booting the whole intro.
document.querySelectorAll<HTMLElement>('.btn').forEach((button) => {
  button.addEventListener('pointerdown', (event) => {
    const box = button.getBoundingClientRect();
    const wave = document.createElement('span');
    wave.className = 'btn__ripple';
    wave.setAttribute('aria-hidden', 'true');
    wave.style.left = `${event.clientX - box.left}px`;
    wave.style.top = `${event.clientY - box.top}px`;
    button.appendChild(wave);
    wave.addEventListener('animationend', () => wave.remove());
  });
});
