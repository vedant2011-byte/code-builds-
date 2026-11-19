import './styles/base.css';
import './styles/site.css';
import './styles/intro.css';

import { initIntro } from './intro';
import { initUI } from './ui';

initUI();

const intro = initIntro();

document
  .querySelector<HTMLElement>('[data-action="replayintro"]')
  ?.addEventListener('click', () => intro.replay());
