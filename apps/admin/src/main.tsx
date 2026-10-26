import { render } from 'preact';
import { t } from '@swarmcast/shared/i18n';
import { initBrowserLang, installTooltips } from '@swarmcast/shared/i18n/browser';
import { App } from './App.js';
import './style.css';

initBrowserLang();
installTooltips();
document.title = t('admin.title');

render(<App />, document.getElementById('app')!);
