import { render } from 'preact';
import { App } from './App';
import { applyMode, applyTheme, boot, getMode } from './config';
import './styles.css';

applyTheme(boot.theme ?? {});
applyMode(getMode());
render(<App />, document.getElementById('app')!);
