import {mkdir,writeFile} from 'node:fs/promises';
import {avatarShapes,avatarPalettes,avatarPaths} from '../upstream/buzz-app/src/team/avatar-presets.ts';
const directory=new URL('../upstream/buzz-app/public/avatars/',import.meta.url);
await mkdir(directory,{recursive:true});
for(const shape of avatarShapes)for(const palette of avatarPalettes){
  const stops=palette.colors.map((color,index)=>`<stop offset="${index/(palette.colors.length-1)*100}%" stop-color="${color}"/>`).join('');
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><defs><linearGradient id="color" x2="1" y2="1">${stops}</linearGradient></defs><path fill="url(#color)" d="${avatarPaths[shape.id]}"/><g fill="white"><rect x="14" y="14" width="3.4" height="8" rx="1.7" transform="rotate(-12 16 18)"/><rect x="23" y="13" width="3.4" height="8" rx="1.7" transform="rotate(-12 25 17)"/></g></svg>\n`;
  await writeFile(new URL(`${shape.id}-${palette.id}.svg`,directory),svg);
}
console.log('Generated 24 first-party avatar presets');
