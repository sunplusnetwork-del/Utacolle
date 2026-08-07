import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// GitHub Pagesで公開する場合、base はリポジトリ名に合わせて変更してください。
// 例: リポジトリ名が "chorus-db" で https://ユーザー名.github.io/chorus-db/ に公開するなら
//     base: '/chorus-db/'
// 独自ドメインのルートに公開する場合は './' のままで問題ありません。
export default defineConfig({
  plugins: [react()],
  base: './',
});
