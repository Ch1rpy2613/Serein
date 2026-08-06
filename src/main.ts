import { mount } from 'svelte';
import './app.css';
import App from './App.svelte';
import {
  listenForPushMessages,
  reconcilePushSubscription,
  registerServiceWorker,
} from './lib/push/subscribe';

const app = mount(App, {
  target: document.getElementById('app')!,
});

if (typeof window !== 'undefined' && 'serviceWorker' in navigator) {
  const bootPush = () => {
    void registerServiceWorker().then(() => {
      listenForPushMessages();
      void reconcilePushSubscription();
    });
  };
  if (document.readyState === 'complete') bootPush();
  else window.addEventListener('load', bootPush, { once: true });
}

export default app;
