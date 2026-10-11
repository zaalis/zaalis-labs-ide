'use strict';
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..'),source=path.join(root,'interface'),destination=path.join(root,'native','dist','interface');
if(!destination.startsWith(path.join(root,'native','dist')+path.sep))throw Error('Invalid interface staging target.');
fs.mkdirSync(destination,{recursive:true});fs.cpSync(source,destination,{recursive:true,force:true,filter:file=>!fs.lstatSync(file).isSymbolicLink()});
console.log('Current IDE interface staged in native/dist/interface.');
