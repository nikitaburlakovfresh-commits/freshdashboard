import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
// Сборка предпросмотра: те же страницы портала, но чтение данных подменено
// зафиксированным ответом прода. В рабочую сборку этот конфиг не участвует.
export default defineConfig({
  plugins:[react()],
  root:path.resolve(__dirname,'preview'),
  resolve:{alias:[{find:/^\.\.\/api\/metrics$/,replacement:path.resolve(__dirname,'preview/fixture.ts')}]},
  build:{outDir:path.resolve(__dirname,'../../card_preview'),emptyOutDir:true},
  base:'./',
});
