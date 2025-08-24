// firebase-config.js — Reemplazá con tus credenciales de Firebase
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getFirestore } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

// ⬇️ Pegá aquí tu objeto de configuración (from Firebase Console)
const firebaseConfig = {
  apiKey: "AIzaSyA2rd8zszXmTslOhgZIAuOszt-d9Zm18vM",
  authDomain: "cumplimiento-239af.firebaseapp.com",
  projectId: "cumplimiento-239af",
  storageBucket: "cumplimiento-239af.firebasestorage.app",
  messagingSenderId: "1057556257320",
  appId: "1:1057556257320:web:9a4ae838d6a78fd67b731d"
};

export const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
