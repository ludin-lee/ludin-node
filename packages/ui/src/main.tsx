import { render } from 'preact';
import { App } from './App';
import { applyMode, applyPreset, applyTheme, boot, getMode, getPreset } from './config';
import './styles.css';

applyTheme(boot.theme ?? {});
applyMode(getMode());
applyPreset(getPreset());
render(<App />, document.getElementById('app')!);
