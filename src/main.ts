import './styles/base.css';
import './styles/site.css';
import './styles/intro.css';
import './styles/arcade.css';
import './styles/letter.css';

import { initArcade } from './arcade';
import { initIntro } from './intro';
import { initLetter } from './letter';
import { initUI } from './ui';

initUI();
initLetter();
initArcade();

const intro = initIntro();

document
  .querySelector<HTMLElement>('[data-action="replayintro"]')
  ?.addEventListener('click', () => intro.replay());
