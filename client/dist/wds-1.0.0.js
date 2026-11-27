/*! WIAI Datastore client library 1.0.0 - hash-wasm Argon2id (MIT, see client/vendor/LICENSE), wds-core.js, wds-ui.js */
(function () {
var module, exports, define;
var WDS_VENDOR_ARGON2 = (function () {
var exports = {}, module = { exports: exports }, define;
/*!
 * hash-wasm (https://www.npmjs.com/package/hash-wasm)
 * (c) Dani Biro
 * @license MIT
 */

!function(A,I){"object"==typeof exports&&"undefined"!=typeof module?I(exports):"function"==typeof define&&define.amd?define(["exports"],I):I((A="undefined"!=typeof globalThis?globalThis:A||self).hashwasm=A.hashwasm||{})}(this,function(A){"use strict";function I(A,I,i,g){return new(i||(i=Promise))(function(C,B){function Q(A){try{h(g.next(A))}catch(A){B(A)}}function E(A){try{h(g.throw(A))}catch(A){B(A)}}function h(A){var I;A.done?C(A.value):(I=A.value,I instanceof i?I:new i(function(A){A(I)})).then(Q,E)}h((g=g.apply(A,I||[])).next())})}"function"==typeof SuppressedError&&SuppressedError;var i,g={name:"argon2",data:"AGFzbQEAAAABKQVgAX8Bf2AAAX9gEH9/f39/f39/f39/f39/f38AYAR/f39/AGACf38AAwYFAAECAwQFBgEBAoCAAgYIAX8BQYCABAsHUwUGbWVtb3J5AgAPX19zdGFja19wb2ludGVyAwASSGFzaF9TZXRNZW1vcnlTaXplAAAOSGFzaF9HZXRCdWZmZXIAAQ5IYXNoX0NhbGN1bGF0ZQAECsc2BV0DAX8BfgF/QQAhAQJAIABBACkDiIAEIgKnIgNGDQBBACEBAkAgACADayIAQRB2IABB//8DcUEAR2oiAEAAQX9HDQBB/wHADwtBACACIABBEHStfDcDiIAECyABwAt0AwJ/AX4BfwJAQQAoAoCABCIADQBBAD8AQRB0IgE2AoCABAJAQQApA4iABCICpyIDQYCAIEYNAEEAIQBBgIAgIANrIgNBEHYgA0H//wNxQQBHaiIDQABBf0YNAUEAIAIgA0EQdK18NwOIgAQLIAEhAAsgAAvcDgECfiAAIAQpAwAiECAAKQMAIhF8IBFCAYZC/v///x+DIBBC/////w+DfnwiEDcDACAMIBAgDCkDAIVCIIkiEDcDACAIIBAgCCkDACIRfCARQgGGQv7///8fgyAQQv////8Pg358IhA3AwAgBCAQIAQpAwCFQiiJIhA3AwAgACAQIAApAwAiEXwgEEL/////D4MgEUIBhkL+////H4N+fCIQNwMAIAwgECAMKQMAhUIwiSIQNwMAIAggECAIKQMAIhF8IBBC/////w+DIBFCAYZC/v///x+DfnwiEDcDACAEIBAgBCkDAIVCAYk3AwAgASAFKQMAIhAgASkDACIRfCARQgGGQv7///8fgyAQQv////8Pg358IhA3AwAgDSAQIA0pAwCFQiCJIhA3AwAgCSAQIAkpAwAiEXwgEUIBhkL+////H4MgEEL/////D4N+fCIQNwMAIAUgECAFKQMAhUIoiSIQNwMAIAEgECABKQMAIhF8IBBC/////w+DIBFCAYZC/v///x+DfnwiEDcDACANIBAgDSkDAIVCMIkiEDcDACAJIBAgCSkDACIRfCAQQv////8PgyARQgGGQv7///8fg358IhA3AwAgBSAQIAUpAwCFQgGJNwMAIAIgBikDACIQIAIpAwAiEXwgEUIBhkL+////H4MgEEL/////D4N+fCIQNwMAIA4gECAOKQMAhUIgiSIQNwMAIAogECAKKQMAIhF8IBFCAYZC/v///x+DIBBC/////w+DfnwiEDcDACAGIBAgBikDAIVCKIkiEDcDACACIBAgAikDACIRfCAQQv////8PgyARQgGGQv7///8fg358IhA3AwAgDiAQIA4pAwCFQjCJIhA3AwAgCiAQIAopAwAiEXwgEEL/////D4MgEUIBhkL+////H4N+fCIQNwMAIAYgECAGKQMAhUIBiTcDACADIAcpAwAiECADKQMAIhF8IBFCAYZC/v///x+DIBBC/////w+DfnwiEDcDACAPIBAgDykDAIVCIIkiEDcDACALIBAgCykDACIRfCARQgGGQv7///8fgyAQQv////8Pg358IhA3AwAgByAQIAcpAwCFQiiJIhA3AwAgAyAQIAMpAwAiEXwgEEL/////D4MgEUIBhkL+////H4N+fCIQNwMAIA8gECAPKQMAhUIwiSIQNwMAIAsgECALKQMAIhF8IBBC/////w+DIBFCAYZC/v///x+DfnwiEDcDACAHIBAgBykDAIVCAYk3AwAgACAFKQMAIhAgACkDACIRfCARQgGGQv7///8fgyAQQv////8Pg358IhA3AwAgDyAQIA8pAwCFQiCJIhA3AwAgCiAQIAopAwAiEXwgEUIBhkL+////H4MgEEL/////D4N+fCIQNwMAIAUgECAFKQMAhUIoiSIQNwMAIAAgECAAKQMAIhF8IBBC/////w+DIBFCAYZC/v///x+DfnwiEDcDACAPIBAgDykDAIVCMIkiEDcDACAKIBAgCikDACIRfCAQQv////8PgyARQgGGQv7///8fg358IhA3AwAgBSAQIAUpAwCFQgGJNwMAIAEgBikDACIQIAEpAwAiEXwgEUIBhkL+////H4MgEEL/////D4N+fCIQNwMAIAwgECAMKQMAhUIgiSIQNwMAIAsgECALKQMAIhF8IBFCAYZC/v///x+DIBBC/////w+DfnwiEDcDACAGIBAgBikDAIVCKIkiEDcDACABIBAgASkDACIRfCAQQv////8PgyARQgGGQv7///8fg358IhA3AwAgDCAQIAwpAwCFQjCJIhA3AwAgCyAQIAspAwAiEXwgEEL/////D4MgEUIBhkL+////H4N+fCIQNwMAIAYgECAGKQMAhUIBiTcDACACIAcpAwAiECACKQMAIhF8IBFCAYZC/v///x+DIBBC/////w+DfnwiEDcDACANIBAgDSkDAIVCIIkiEDcDACAIIBAgCCkDACIRfCARQgGGQv7///8fgyAQQv////8Pg358IhA3AwAgByAQIAcpAwCFQiiJIhA3AwAgAiAQIAIpAwAiEXwgEEL/////D4MgEUIBhkL+////H4N+fCIQNwMAIA0gECANKQMAhUIwiSIQNwMAIAggECAIKQMAIhF8IBBC/////w+DIBFCAYZC/v///x+DfnwiEDcDACAHIBAgBykDAIVCAYk3AwAgAyAEKQMAIhAgAykDACIRfCARQgGGQv7///8fgyAQQv////8Pg358IhA3AwAgDiAQIA4pAwCFQiCJIhA3AwAgCSAQIAkpAwAiEXwgEUIBhkL+////H4MgEEL/////D4N+fCIQNwMAIAQgECAEKQMAhUIoiSIQNwMAIAMgECADKQMAIhF8IBBC/////w+DIBFCAYZC/v///x+DfnwiEDcDACAOIBAgDikDAIVCMIkiEDcDACAJIBAgCSkDACIRfCAQQv////8PgyARQgGGQv7///8fg358IhA3AwAgBCAQIAQpAwCFQgGJNwMAC+MdAQN/QQAhBEEAIAIpAwAgASkDAIU3A5CABEEAIAIpAwggASkDCIU3A5iABEEAIAIpAxAgASkDEIU3A6CABEEAIAIpAxggASkDGIU3A6iABEEAIAIpAyAgASkDIIU3A7CABEEAIAIpAyggASkDKIU3A7iABEEAIAIpAzAgASkDMIU3A8CABEEAIAIpAzggASkDOIU3A8iABEEAIAIpA0AgASkDQIU3A9CABEEAIAIpA0ggASkDSIU3A9iABEEAIAIpA1AgASkDUIU3A+CABEEAIAIpA1ggASkDWIU3A+iABEEAIAIpA2AgASkDYIU3A/CABEEAIAIpA2ggASkDaIU3A/iABEEAIAIpA3AgASkDcIU3A4CBBEEAIAIpA3ggASkDeIU3A4iBBEEAIAIpA4ABIAEpA4ABhTcDkIEEQQAgAikDiAEgASkDiAGFNwOYgQRBACACKQOQASABKQOQAYU3A6CBBEEAIAIpA5gBIAEpA5gBhTcDqIEEQQAgAikDoAEgASkDoAGFNwOwgQRBACACKQOoASABKQOoAYU3A7iBBEEAIAIpA7ABIAEpA7ABhTcDwIEE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",hash:"2b50b0d6"};class C{constructor(){this.mutex=Promise.resolve()}lock(){let A=()=>{};return this.mutex=this.mutex.then(()=>new Promise(A)),new Promise(I=>{A=I})}dispatch(A){return I(this,void 0,void 0,function*(){const I=yield this.lock();try{return yield Promise.resolve(A())}finally{I()}})}}const B="undefined"!=typeof globalThis?globalThis:"undefined"!=typeof self?self:"undefined"!=typeof window?window:global,Q=null!==(i=B.Buffer)&&void 0!==i?i:null,E=B.TextEncoder?new B.TextEncoder:null;function h(A,I){return(15&A)+(A>>6|A>>3&8)<<4|(15&I)+(I>>6|I>>3&8)}function w(A,I){const i=I.length>>1;for(let g=0;g<i;g++){const i=g<<1;A[g]=h(I.charCodeAt(i),I.charCodeAt(i+1))}}const e="a".charCodeAt(0)-10,t="0".charCodeAt(0);function o(A,I,i){let g=0;for(let C=0;C<i;C++){let i=I[C]>>>4;A[g++]=i>9?i+e:i+t,i=15&I[C],A[g++]=i>9?i+e:i+t}return String.fromCharCode.apply(null,A)}const n=null!==Q?A=>{if("string"==typeof A){const I=Q.from(A,"utf8");return new Uint8Array(I.buffer,I.byteOffset,I.length)}if(Q.isBuffer(A))return new Uint8Array(A.buffer,A.byteOffset,A.length);if(ArrayBuffer.isView(A))return new Uint8Array(A.buffer,A.byteOffset,A.byteLength);throw new Error("Invalid data type!")}:A=>{if("string"==typeof A)return E.encode(A);if(ArrayBuffer.isView(A))return new Uint8Array(A.buffer,A.byteOffset,A.byteLength);throw new Error("Invalid data type!")},f="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/",r=new Uint8Array(256);for(let A=0;A<64;A++)r[f.charCodeAt(A)]=A;function F(A,I=!0){const i=A.length,g=i%3,C=[],B=i-g;for(let I=0;I<B;I+=3){const i=(A[I]<<16&16711680)+(A[I+1]<<8&65280)+(255&A[I+2]),g=f.charAt(i>>18&63)+f.charAt(i>>12&63)+f.charAt(i>>6&63)+f.charAt(63&i);C.push(g)}if(1===g){const g=A[i-1],B=f.charAt(g>>2),Q=f.charAt(g<<4&63);C.push(`${B}${Q}`),I&&C.push("==")}else if(2===g){const g=(A[i-2]<<8)+A[i-1],B=f.charAt(g>>10),Q=f.charAt(g>>4&63),E=f.charAt(g<<2&63);C.push(`${B}${Q}${E}`),I&&C.push("=")}return C.join("")}function D(A){let I=Math.floor(.75*A.length);const i=A.length;return"="===A[i-1]&&(I-=1,"="===A[i-2]&&(I-=1)),I}function a(A){const I=D(A),i=A.length,g=new Uint8Array(I);let C=0;for(let I=0;I<i;I+=4){const i=r[A.charCodeAt(I)],B=r[A.charCodeAt(I+1)],Q=r[A.charCodeAt(I+2)],E=r[A.charCodeAt(I+3)];g[C]=i<<2|B>>4,C+=1,g[C]=(15&B)<<4|Q>>2,C+=1,g[C]=(3&Q)<<6|63&E,C+=1}return g}const s=16384,U=new C,S=new Map;function c(A,i){return I(this,void 0,void 0,function*(){let g=null,C=null,B=!1;if("undefined"==typeof WebAssembly)throw new Error("WebAssembly is not supported in this environment!");const Q=()=>new DataView(g.exports.memory.buffer).getUint32(g.exports.STATE_SIZE,!0),E=U.dispatch(()=>I(this,void 0,void 0,function*(){if(!S.has(A.name)){const I=a(A.data),i=WebAssembly.compile(I.buffer);S.set(A.name,i)}const I=yield S.get(A.name);g=yield WebAssembly.instantiate(I,{})})),e=(A=null)=>{B=!0,g.exports.Hash_Init(A)},t=A=>{if(!B)throw new Error("update() called before init()");(A=>{let I=0;for(;I<A.length;){const i=A.subarray(I,I+s);I+=i.length,C.set(i),g.exports.Hash_Update(i.length)}})(n(A))},f=new Uint8Array(2*i),r=(A,I=null)=>{if(!B)throw new Error("digest() called before init()");return B=!1,g.exports.Hash_Final(I),"binary"===A?C.slice(0,i):o(f,C,i)},F=A=>"string"==typeof A?A.length<4096:A.byteLength<s;let D=F;switch(A.name){case"argon2":case"scrypt":D=()=>!0;break;case"blake2b":case"blake2s":D=(A,I)=>I<=512&&F(A);break;case"blake3":D=(A,I)=>0===I&&F(A);break;case"xxhash64":case"xxhash3":case"xxhash128":case"crc64":D=()=>!1}return yield(()=>I(this,void 0,void 0,function*(){g||(yield E);const A=g.exports.Hash_GetBuffer(),I=g.exports.memory.buffer;C=new Uint8Array(I,A,s)}))(),{getMemory:()=>C,writeMemory:(A,I=0)=>{C.set(A,I)},getExports:()=>g.exports,setMemorySize:A=>{g.exports.Hash_SetMemorySize(A);const I=g.exports.Hash_GetBuffer(),i=g.exports.memory.buffer;C=new Uint8Array(i,I,A)},init:e,update:t,digest:r,save:()=>{if(!B)throw new Error("save() can only be called after init() and before digest()");const I=g.exports.Hash_GetState(),i=Q(),C=g.exports.memory.buffer,E=new Uint8Array(C,I,i),h=new Uint8Array(4+i);return w(h,A.hash),h.set(E,4),h},load:I=>{if(!(I instanceof Uint8Array))throw new Error("load() expects an Uint8Array generated by save()");const i=g.exports.Hash_GetState(),C=Q(),E=4+C,w=g.exports.memory.buffer;if(I.length!==E)throw new Error(`Bad state length (expected ${E} bytes, got ${I.length})`);if(!function(A,I){if(A.length!==2*I.length)return!1;for(let i=0;i<I.length;i++){const g=i<<1;if(I[i]!==h(A.charCodeAt(g),A.charCodeAt(g+1)))return!1}return!0}(A.hash,I.subarray(0,4)))throw new Error("This state was written by an incompatible hash implementation");const e=I.subarray(4);new Uint8Array(w,i,C).set(e),B=!0},calculate:(A,I=null,B=null)=>{if(!D(A,I))return e(I),t(A),r("hex",B);const Q=n(A);return C.set(Q),g.exports.Hash_Calculate(Q.length,I,B),o(f,C,i)},hashLength:i}})}var k={name:"blake2b",data:"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",hash:"22cf500a"};function G(A){return!Number.isInteger(A)||A<8||A>512||A%8!=0?new Error("Invalid variant! Valid values: 8, 16, ..., 512"):null}function p(A=512,I=null){if(G(A))return Promise.reject(G(A));let i=null,g=A;if(null!==I){if(i=n(I),i.length>64)return Promise.reject(new Error("Max key length is 64 bytes"));C=A,B=i.length,g=C|B<<16}var C,B;const Q=A/8;return c(k,Q).then(A=>{g>512&&A.writeMemory(i),A.init(g);const I={init:g>512?()=>(A.writeMemory(i),A.init(g),I):()=>(A.init(g),I),update:i=>(A.update(i),I),digest:I=>A.digest(I),save:()=>A.save(),load:i=>(A.load(i),I),blockSize:128,digestSize:Q};return I})}new C;const y=new DataView(new ArrayBuffer(4));function H(A){return y.setInt32(0,A,!0),new Uint8Array(y.buffer)}function u(A,i,g){return I(this,void 0,void 0,function*(){if(g<=64){const A=yield p(8*g);return A.update(H(g)),A.update(i),A.digest("binary")}const I=Math.ceil(g/32)-2,C=new Uint8Array(g);A.init(),A.update(H(g)),A.update(i);let B=A.digest("binary");C.set(B.subarray(0,32),0);for(let i=1;i<I;i++)A.init(),A.update(B),B=A.digest("binary"),C.set(B.subarray(0,32),32*i);const Q=g-32*I;let E;return 64===Q?(E=A,E.init()):E=yield p(8*Q),E.update(B),B=E.digest("binary"),C.set(B.subarray(0,Q),32*I),C})}function Y(A){return I(this,void 0,void 0,function*(){var I;const{parallelism:i,iterations:C,hashLength:B}=A,Q=n(A.password),E=n(A.salt),h=function(A){switch(A){case"d":return 0;case"i":return 1;default:return 2}}(A.hashType),{memorySize:e}=A,t=n(null!==(I=A.secret)&&void 0!==I?I:""),[f,r]=yield Promise.all([c(g,1024),p(512)]);f.setMemorySize(1024*e+1024);const D=new Uint8Array(24),a=new DataView(D.buffer);a.setInt32(0,i,!0),a.setInt32(4,B,!0),a.setInt32(8,e,!0),a.setInt32(12,C,!0),a.setInt32(16,19,!0),a.setInt32(20,h,!0),f.writeMemory(D,1024*e),r.init(),r.update(D),r.update(H(Q.length)),r.update(Q),r.update(H(E.length)),r.update(E),r.update(H(t.length)),r.update(t),r.update(H(0));const s=4*Math.floor(e/(4*i)),U=new Uint8Array(72),S=r.digest("binary");U.set(S);for(let A=0;A<i;A++){U.set(H(0),64),U.set(H(A),68);let I=A*s,i=yield u(r,U,1024);f.writeMemory(i,1024*I),I+=1,U.set(H(1),64),i=yield u(r,U,1024),f.writeMemory(i,1024*I)}const k=new Uint8Array(1024);w(k,f.calculate(new Uint8Array([]),e));const G=yield u(r,k,B);if("hex"===A.outputType){return o(new Uint8Array(2*B),G,B)}return"encoded"===A.outputType?function(A,I,i){const g=[`m=${I.memorySize}`,`t=${I.iterations}`,`p=${I.parallelism}`].join(",");return`$argon2${I.hashType}$v=19$${g}$${F(A,!1)}$${F(i,!1)}`}(E,A,G):G})}const V=A=>{var I;if(!A||"object"!=typeof A)throw new Error("Invalid options parameter. It requires an object.");if(!A.password)throw new Error("Password must be specified");if(A.password=n(A.password),A.password.length<1)throw new Error("Password must be specified");if(!A.salt)throw new Error("Salt must be specified");if(A.salt=n(A.salt),A.salt.length<8)throw new Error("Salt should be at least 8 bytes long");if(A.secret=n(null!==(I=A.secret)&&void 0!==I?I:""),!Number.isInteger(A.iterations)||A.iterations<1)throw new Error("Iterations should be a positive number");if(!Number.isInteger(A.parallelism)||A.parallelism<1)throw new Error("Parallelism should be a positive number");if(!Number.isInteger(A.hashLength)||A.hashLength<4)throw new Error("Hash length should be at least 4 bytes.");if(!Number.isInteger(A.memorySize))throw new Error("Memory size should be specified.");if(A.memorySize<8*A.parallelism)throw new Error("Memory size should be at least 8 * parallelism.");if(void 0===A.outputType&&(A.outputType="hex"),!["hex","binary","encoded"].includes(A.outputType))throw new Error(`Insupported output type ${A.outputType}. Valid values: ['hex', 'binary', 'encoded']`)};A.argon2Verify=function(A){return I(this,void 0,void 0,function*(){(A=>{if(!A||"object"!=typeof A)throw new Error("Invalid options parameter. It requires an object.");if(void 0===A.hash||"string"!=typeof A.hash)throw new Error("Hash should be specified")})(A);const I=((A,I,i)=>{const g=I.match(/^\$argon2(id|i|d)\$v=([0-9]+)\$((?:[mtp]=[0-9]+,){2}[mtp]=[0-9]+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/);if(!g)throw new Error("Invalid hash");const[,C,B,Q,E,h]=g;if("19"!==B)throw new Error(`Unsupported version: ${B}`);const w={},e={m:"memorySize",p:"parallelism",t:"iterations"};for(const A of Q.split(",")){const[I,i]=A.split("=");w[e[I]]=Number(i)}return Object.assign(Object.assign({},w),{password:A,secret:i,hashType:C,salt:a(E),hashLength:D(h),outputType:"encoded"})})(A.password,A.hash,A.secret);V(I);const i=A.hash.lastIndexOf("$")+1;return(yield Y(I)).substring(i)===A.hash.substring(i)})},A.argon2d=function(A){return I(this,void 0,void 0,function*(){return V(A),Y(Object.assign(Object.assign({},A),{hashType:"d"}))})},A.argon2i=function(A){return I(this,void 0,void 0,function*(){return V(A),Y(Object.assign(Object.assign({},A),{hashType:"i"}))})},A.argon2id=function(A){return I(this,void 0,void 0,function*(){return V(A),Y(Object.assign(Object.assign({},A),{hashType:"id"}))})}});
if (typeof module.exports.argon2id !== "function") throw new Error("wds: the bundled Argon2id function is missing");
return module.exports.argon2id;
})();
;
/*!
 * wds-core.js - WIAI Datastore: cryptography and protocol client (wire protocol v1, see PROTOCOL.md).
 *
 * UMD: loads as a classic script (window.WDSCore) and can be required from Node (>= 20, WebCrypto required).
 * Argon2id comes from the vendored hash-wasm build. In the production bundle (client/build.mjs) the build hands the
 * function to this file through a private variable and the bundle exposes no test hooks (no setRandom, setArgon2 or
 * internals). When this file is loaded on its own (tests, tools), Argon2id is taken once, at load time, from the global
 * "hashwasm" if present, or from the "argon2" client option; WDSCore.setRandom/setArgon2/internals exist only then.
 *
 * Layout: 1 primitives and encodings, 2 envelopes/records/slots/keyring, 3 roster, 4 codes, 5 errors, 6 Client.
 * Everything that is signed, hashed or MACed uses canonical JSON (cjson).
 *
 * API summary (all methods async unless noted; errors are WDSError subclasses, see "errors"):
 *
 *   const c = new WDSCore.Client({ scope, service?, fetch?, storage?, now?, argon2?, escrowPins? })
 *     service      API origin + mount path, default WDSCore.SERVICE_URL
 *     fetch        injectable (tests); storage: localStorage-like {getItem,setItem,removeItem}, default localStorage
 *     argon2       injectable Argon2id (default: the vendored build). escrowPins / retiredEscrow: escrow key IDs the library
 *                  accepts (tests only: a build with escrow pins ignores both options, see BUILTIN_ESCROW_PINS)
 *     timeout      ms a request may take until the answer (and its body) has arrived, default Client.defaultTimeout (30000), 0 = no limit;
 *                  an upload gets one more second per 10 KB (the budget assumes at least 80 kbit/s), creating a vault and redeeming an
 *                  invite three times the time. A request that does not answer in time fails with an OfflineError (code "timeout"),
 *                  so a stalled connection can never keep a dialog waiting for ever. After a timeout of a write the client looks at
 *                  the record before it reports the failure: an answer that was lost after the server had stored the write counts as saved.
 *                  Client.defaultTimeout is a plain static (a test page sets it before the library connects; an app has no reason to).
 *   c.getScopeInfo(force?)                    GET /scopes/{scope} (kdf defaults, limits, privacy_url)
 *   c.createVault({passphrase, joinCode?})
 *        -> {accessId, accessIdDisplay, vaultId, recoveryCode:{canonical,display}}; unlocks (the recovery code is the "emergency code" of the dialogs)
 *   c.unlock({accessId, passphrase, maintain?})             -> status()
 *   c.redeemInvite({inviteCode, passphrase})                -> status(); unlocks
 *   c.lock(); c.status() (sync): {unlocked, role, epoch, rosterVersion, rekeyPending, recoveredByFaculty, escrowRetired, newDevice,
 *        stateStatus: 'ok'|'new'|'invalid', recovery, warnings, ...}
 *   c.get(name, {fresh?}) -> value|undefined      c.getRecord(name, {fresh?}) -> {name,version,kind,mime,time,length,epoch,value}|null
 *        fresh: skip the short-lived copy that list() keeps, always read from the server
 *   c.put(name, value, {mime?, base?})  value: JSON value | Uint8Array | ArrayBuffer | Blob. base: omitted = version this
 *        client knows (If-None-Match for unknown names), null = must not exist, n = If-Match n; an explicit undefined is a
 *        UsageError (a base that was never read must not silently fall back to what this client happens to know). Rejects with
 *        ConflictError {record, mine, theirs:{version,deleted,value,...}|null, current}; resolve with put(..., {base: err.current}).
 *   c.delete(name, {base?}) (alias remove) -> bool      c.list(prefix?) -> [{name,version,kind,mime,length,time,epoch}]
 *   c.history(name), c.getVersion(name, n), c.restore(name, n), c.deleteHistory(name) (owner), c.usage(), c.readAll(prefix?)
 *   c.checkRemote() -> [{name, version, known, deleted}] records read/written here that are newer on the server
 *   c.cancelRecovery() (owner)
 *   c.members() (sync), c.createInvite({role:'write'|'read', expiresIn?}) -> {code:{canonical,display}, ...} (owner)
 *   c.cancelInvite(slotId, {revoke?}) (an invite the server saw in use is withdrawn by a revocation, see the method),
 *        c.setRole(slotId, role), c.revoke(slotIds, {rekey?, maxItems?, onProgress?}) (owner; owner slots
 *        only under the rule in PLAN 5.7: an owner may revoke owner slots added by escrow, and an escrow-added owner may
 *        revoke the slots that existed before; see c.members()[i].revocable)
 *   c.resumeRekey({maxItems?, onProgress?, dropOld?}) -> {done, rekeyed}; c.adoptRenewals();
 *   c.changePassphrase(newPassphrase); c.maintain(); c.acknowledgeRecovery(); c.deleteVault()
 *   c.rememberedAccessId() / rememberedAccess() -> {id, t} / rememberAccessId(id) / forgetAccessId()   (localStorage "wds:<scope>:access_id", JSON {id, t})
 *   WDSCore.parseInviteCode / parseRecoveryCode / classifyCode / displayCode / normalizeCode
 *   WDSCore.internals: low-level building blocks used by tests, vectors and tools (not for app code; not in the bundle).
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module && module.exports) module.exports = factory(root);
  else root.WDSCore = factory(root);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  var VERSION = '1.0.0';
  var SERVICE_URL = 'https://wiai.uni-bamberg.de/datastore/';
  // SHA-256 based IDs (b64u of SHA-256(E.pub || S.pub)) of the escrow key sets the library accepts for new work:
  // current and spare (PROTOCOL.md 3.4). Filled in by the build once wds-keygen has produced the keys. When this list
  // is not empty, the "escrowPins" and "retiredEscrow" client options are ignored (they exist for tests only).
  var BUILTIN_ESCROW_PINS = ["jPpQPgYBsi1_jbhpXomvO_qDGg6B_oqL8t8qCEU7AAg","tVvmpc-8Du0iPnpniKhKa3vmXgL4uJ0atqDP6dOY1ic"];
  // Escrow key sets that earlier library versions pinned and that were retired since: [{id, until}]. They stay valid
  // for the history of a vault (versions that name them, and escrow-signed versions with time <= until) but are never
  // accepted as the head of a vault an owner works on and never receive new keyring entries. Filled in by the build.
  var BUILTIN_RETIRED_ESCROW = [];
  // The build sets this to true: no test hooks, no global lookups of the Argon2id function.
  var PRODUCTION = true;

  // ------------------------------------------------------------------------------------------------------------
  // 5. Errors (defined first, used everywhere)
  // ------------------------------------------------------------------------------------------------------------
  class WDSError extends Error {
    constructor(message, props) {
      super(message);
      this.name = this.constructor.name;
      if (props) Object.assign(this, props);
    }
  }
  class ConflictError extends WDSError {}
  class OfflineError extends WDSError {}
  class QuotaError extends WDSError {}
  class AuthError extends WDSError {}
  class IntegrityError extends WDSError {}
  class VersionError extends WDSError {}
  class RequestError extends WDSError {}
  class UsageError extends WDSError {}

  // ------------------------------------------------------------------------------------------------------------
  // 1. Primitives and encodings
  // ------------------------------------------------------------------------------------------------------------
  var te = new TextEncoder();
  var tdFatal = new TextDecoder('utf-8', { fatal: true });
  var rng = null; // test hook (not exported in the production bundle): function (n) -> Uint8Array
  function randomBytes(n) {
    if (!PRODUCTION && rng) return rng(n);
    var b = new Uint8Array(n);
    root.crypto.getRandomValues(b);
    return b;
  }
  function setRandom(fn) { rng = fn || null; }

  function concat() {
    var n = 0, i, a;
    for (i = 0; i < arguments.length; i++) n += arguments[i].length;
    var out = new Uint8Array(n), o = 0;
    for (i = 0; i < arguments.length; i++) { a = arguments[i]; out.set(a, o); o += a.length; }
    return out;
  }
  function u32(n) {
    if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) throw new UsageError('u32 out of range');
    return new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
  }
  function readU32(b, o) { return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0; }
  function lp(x) { return concat(u32(x.length), x); }
  function ascii(s) {
    if (typeof s !== 'string') throw new UsageError('ascii: not a string');
    var b = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c > 127) throw new UsageError('ascii: non-ASCII character');
      b[i] = c;
    }
    return b;
  }
  function utf8(s) { return te.encode(s); }
  function utf8Decode(b) {
    try { return tdFatal.decode(b); } catch (e) { throw new IntegrityError('invalid UTF-8'); }
  }
  function hex(b) {
    var s = '';
    for (var i = 0; i < b.length; i++) s += (b[i] < 16 ? '0' : '') + b[i].toString(16);
    return s;
  }
  function unhex(s) {
    if (typeof s !== 'string' || s.length % 2 || /[^0-9a-f]/.test(s)) throw new UsageError('invalid hex');
    var b = new Uint8Array(s.length / 2);
    for (var i = 0; i < b.length; i++) b[i] = parseInt(s.substr(i * 2, 2), 16);
    return b;
  }
  function bytesEqual(a, b) {
    if (a.length !== b.length) return false;
    var d = 0;
    for (var i = 0; i < a.length; i++) d |= a[i] ^ b[i];
    return d === 0;
  }
  function toBytes(x) {
    if (x instanceof Uint8Array) return x;
    if (x instanceof ArrayBuffer) return new Uint8Array(x);
    if (ArrayBuffer.isView(x)) return new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
    throw new UsageError('expected bytes (Uint8Array or ArrayBuffer)');
  }

  // ---- base64url (strict) ----
  var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  var B64REV = (function () {
    var t = new Int16Array(128).fill(-1);
    for (var i = 0; i < 64; i++) t[B64.charCodeAt(i)] = i;
    return t;
  })();
  function b64u(bytes) {
    bytes = toBytes(bytes);
    var out = [], i = 0, n = bytes.length, chunk = '';
    for (; i + 2 < n; i += 3) {
      var v = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
      chunk += B64[v >> 18] + B64[(v >> 12) & 63] + B64[(v >> 6) & 63] + B64[v & 63];
      if (chunk.length >= 8192) { out.push(chunk); chunk = ''; }
    }
    if (n - i === 1) {
      var v1 = bytes[i] << 16;
      chunk += B64[v1 >> 18] + B64[(v1 >> 12) & 63];
    } else if (n - i === 2) {
      var v2 = (bytes[i] << 16) | (bytes[i + 1] << 8);
      chunk += B64[v2 >> 18] + B64[(v2 >> 12) & 63] + B64[(v2 >> 6) & 63];
    }
    out.push(chunk);
    return out.join('');
  }
  function b64uDecode(s, expectLen) {
    if (typeof s !== 'string') throw new IntegrityError('base64url: not a string');
    var n = s.length;
    if (n % 4 === 1) throw new IntegrityError('base64url: bad length');
    var outLen = Math.floor(n * 3 / 4);
    var out = new Uint8Array(outLen), o = 0, acc = 0, bits = 0;
    for (var i = 0; i < n; i++) {
      var c = s.charCodeAt(i);
      var v = c < 128 ? B64REV[c] : -1;
      if (v < 0) throw new IntegrityError('base64url: invalid character');
      acc = (acc << 6) | v; bits += 6;
      if (bits >= 8) { bits -= 8; out[o++] = (acc >> bits) & 255; acc &= (1 << bits) - 1; }
    }
    if (acc !== 0) throw new IntegrityError('base64url: non-canonical encoding');
    if (expectLen !== undefined && o !== expectLen) throw new IntegrityError('base64url: unexpected length');
    return out;
  }

  // ---- Crockford base32 with check bits ----
  var CROCK = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  var CROCK_REV = (function () {
    var t = {};
    for (var i = 0; i < 32; i++) t[CROCK[i]] = i;
    return t;
  })();
  function symbolsFromBits(bytes, tailValue, tailBits, maxSymbols) {
    var acc = 0, nb = 0, out = '';
    function feed(val, bits) {
      acc = (acc << bits) | val; nb += bits;
      while (nb >= 5 && out.length < maxSymbols) { out += CROCK[(acc >> (nb - 5)) & 31]; nb -= 5; }
      acc &= (1 << nb) - 1;
    }
    for (var i = 0; i < bytes.length; i++) feed(bytes[i], 8);
    if (tailBits) feed(tailValue, tailBits);
    return out;
  }
  function checkBitCount(n) { return (5 - ((8 * n) % 5)) % 5; }
  async function b32cEncode(bytes) {
    bytes = toBytes(bytes);
    var k = checkBitCount(bytes.length);
    var h = k ? (await sha256(bytes))[0] >> (8 - k) : 0;
    return symbolsFromBits(bytes, h, k, Infinity);
  }
  function normalizeCode(s) {
    if (typeof s !== 'string') throw new UsageError('code: not a string');
    s = s.toUpperCase().replace(/[ \t\r\n \-.]/g, '');
    var out = '';
    for (var i = 0; i < s.length; i++) {
      var c = s[i];
      if (c === 'O') c = '0'; else if (c === 'I' || c === 'L') c = '1';
      if (CROCK_REV[c] === undefined) throw new UsageError('code: invalid character', { code: 'invalid_code' });
      out += c;
    }
    return out;
  }
  async function b32cDecode(str, expectedBytes) {
    var s = normalizeCode(str);
    var k = checkBitCount(expectedBytes);
    var want = (8 * expectedBytes + k) / 5;
    if (s.length !== want) throw new UsageError('code: wrong length', { code: 'invalid_code' });
    var acc = 0, nb = 0, out = new Uint8Array(expectedBytes), o = 0, tail = 0;
    for (var i = 0; i < s.length; i++) {
      acc = (acc << 5) | CROCK_REV[s[i]]; nb += 5;
      while (nb >= 8 && o < expectedBytes) { nb -= 8; out[o++] = (acc >> nb) & 255; acc &= (1 << nb) - 1; }
    }
    tail = acc; // remaining k bits
    if (k) {
      var h = (await sha256(out))[0] >> (8 - k);
      if (h !== tail) throw new UsageError('code: check bits do not match', { code: 'invalid_code' });
    }
    return out;
  }
  function plainCrockford(bytes, nSymbols) { return symbolsFromBits(toBytes(bytes), 0, 0, nSymbols); }
  function displayCode(s) { return s.replace(/(.{4})(?=.)/g, '$1-'); }

  // ---- canonical JSON ----
  function cjsonCheckString(s) {
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c < 0x20 || c > 0x7e || c === 0x22 || c === 0x5c) throw new UsageError('cjson: character not allowed in string');
    }
  }
  function cjson(v) {
    if (v === null) return 'null';
    var t = typeof v;
    if (t === 'boolean') return v ? 'true' : 'false';
    if (t === 'number') {
      if (!Number.isSafeInteger(v) || v < 0 || Object.is(v, -0)) throw new UsageError('cjson: not a non-negative safe integer');
      return String(v);
    }
    if (t === 'string') { cjsonCheckString(v); return '"' + v + '"'; }
    if (Array.isArray(v)) return '[' + v.map(cjson).join(',') + ']';
    if (t === 'object') {
      if (Object.prototype.toString.call(v) !== '[object Object]') throw new UsageError('cjson: not a plain object');
      var keys = Object.keys(v).sort();
      var parts = [];
      for (var i = 0; i < keys.length; i++) {
        cjsonCheckString(keys[i]);
        if (v[keys[i]] === undefined) throw new UsageError('cjson: undefined value');
        parts.push('"' + keys[i] + '":' + cjson(v[keys[i]]));
      }
      return '{' + parts.join(',') + '}';
    }
    throw new UsageError('cjson: unsupported value');
  }
  function cjsonBytes(v) { return ascii(cjson(v)); }
  // Strict parser for canonical documents: no whitespace, keys strictly ascending (so no duplicates),
  // integers only, no escapes. Anything else is an IntegrityError.
  function cjsonParse(text) {
    var i = 0, n = text.length;
    function fail(m) { throw new IntegrityError('non-canonical JSON: ' + m); }
    function str() {
      if (text[i] !== '"') fail('string expected');
      var j = ++i;
      while (i < n && text[i] !== '"') {
        var c = text.charCodeAt(i);
        if (c < 0x20 || c > 0x7e || c === 0x5c) fail('character in string');
        i++;
      }
      if (i >= n) fail('unterminated string');
      var s = text.slice(j, i); i++;
      return s;
    }
    function val(depth) {
      if (depth > 32) fail('too deep');
      var c = text[i];
      if (c === '{') {
        i++; var o = {}, last = null;
        if (text[i] === '}') { i++; return o; }
        for (;;) {
          var k = str();
          if (last !== null && !(k > last)) fail('keys not strictly ascending');
          last = k;
          if (text[i] !== ':') fail(': expected'); i++;
          o[k] = val(depth + 1);
          if (text[i] === ',') { i++; continue; }
          if (text[i] === '}') { i++; return o; }
          fail('bad object');
        }
      }
      if (c === '[') {
        i++; var a = [];
        if (text[i] === ']') { i++; return a; }
        for (;;) {
          a.push(val(depth + 1));
          if (text[i] === ',') { i++; continue; }
          if (text[i] === ']') { i++; return a; }
          fail('bad array');
        }
      }
      if (c === '"') return str();
      if (text.startsWith('true', i)) { i += 4; return true; }
      if (text.startsWith('false', i)) { i += 5; return false; }
      if (text.startsWith('null', i)) { i += 4; return null; }
      var m = /^(0|[1-9][0-9]*)/.exec(text.slice(i, i + 20));
      if (!m) fail('value expected');
      var num = Number(m[1]);
      if (!Number.isSafeInteger(num)) fail('integer too large');
      i += m[1].length;
      if (/^[.eE]/.test(text.slice(i, i + 1))) fail('float');
      return num;
    }
    var v = val(0);
    if (i !== n) fail('trailing data');
    return v;
  }

  // ---- Padme ----
  function bitlen(x) { return x === 0 ? 0 : 32 - Math.clz32(x); }
  function padme(L) {
    if (!Number.isInteger(L) || L < 1 || L > 0xffffffff) throw new UsageError('padme: bad length');
    var E = bitlen(L) - 1, S = bitlen(E), z = E - S, p = Math.pow(2, z);
    return Math.ceil(L / p) * p;
  }

  // ---- WebCrypto wrappers ----
  function subtle() {
    var c = root.crypto;
    if (!c || !c.subtle) throw new WDSError('WebCrypto (crypto.subtle) is not available; a secure context is required');
    return c.subtle;
  }
  async function sha256(data) { return new Uint8Array(await subtle().digest('SHA-256', toBytes(data))); }
  var EMPTY = new Uint8Array(0);
  async function hkdf(ikm, salt, info) {
    var k = await subtle().importKey('raw', toBytes(ikm), 'HKDF', false, ['deriveBits']);
    var bits = await subtle().deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: salt || EMPTY, info: ascii(info) }, k, 256);
    return new Uint8Array(bits);
  }
  async function hmacKey(raw) {
    return subtle().importKey('raw', toBytes(raw), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  }
  async function hmacSign(key, data) { return new Uint8Array(await subtle().sign('HMAC', key, toBytes(data))); }
  // A key argument is either raw bytes or an already imported (non-extractable) CryptoKey.
  function isKey(x) { return !!x && typeof x === 'object' && typeof x.type === 'string' && typeof x.extractable === 'boolean'; }
  async function hmac(key, data) { return hmacSign(isKey(key) ? key : await hmacKey(key), data); }
  async function aesKey(raw) { return isKey(raw) ? raw : subtle().importKey('raw', toBytes(raw), 'AES-GCM', false, ['encrypt', 'decrypt']); }
  async function aesSeal(key, nonce, plaintext, aad) {
    return new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad, tagLength: 128 }, key, plaintext));
  }
  async function aesOpen(key, nonce, ct, aad) {
    try {
      return new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad, tagLength: 128 }, key, ct));
    } catch (e) {
      throw new IntegrityError('decryption failed (wrong key, tampered data or wrong context)', { code: 'decrypt_failed' });
    }
  }
  var ECDH = { name: 'ECDH', namedCurve: 'P-256' }, ECDSA = { name: 'ECDSA', namedCurve: 'P-256' };
  function checkPub(pub) {
    if (!pub || !ArrayBuffer.isView(pub) || pub.length !== 65 || pub[0] !== 4) throw new IntegrityError('invalid public key encoding');
  }
  async function generateKeyPair(kind) { // kind 'E' (ECDH) or 'S' (ECDSA)
    var kp = await subtle().generateKey(kind === 'E' ? ECDH : ECDSA, true, kind === 'E' ? ['deriveBits'] : ['sign', 'verify']);
    var jwk = await subtle().exportKey('jwk', kp.privateKey);
    var pub = new Uint8Array(await subtle().exportKey('raw', kp.publicKey));
    return { d: b64uDecode(jwk.d, 32), pub: pub };
  }
  async function importPrivate(kind, d, pub) {
    checkPub(pub);
    var jwk = { kty: 'EC', crv: 'P-256', d: b64u(d), x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) };
    return subtle().importKey('jwk', jwk, kind === 'E' ? ECDH : ECDSA, false, kind === 'E' ? ['deriveBits'] : ['sign']);
  }
  async function importPublic(kind, pub) {
    checkPub(pub);
    return subtle().importKey('raw', pub, kind === 'E' ? ECDH : ECDSA, true, kind === 'E' ? [] : ['verify']);
  }
  async function ecdh(privKey, pub) {
    var pk = await importPublic('E', pub);
    return new Uint8Array(await subtle().deriveBits({ name: 'ECDH', public: pk }, privKey, 256));
  }
  async function ecdsaSign(privKey, data) {
    return new Uint8Array(await subtle().sign({ name: 'ECDSA', hash: 'SHA-256' }, privKey, toBytes(data)));
  }
  async function ecdsaVerify(pub, sig, data) {
    if (sig.length !== 64) return false;
    var pk = await importPublic('S', pub);
    return subtle().verify({ name: 'ECDSA', hash: 'SHA-256' }, pk, sig, toBytes(data));
  }

  // ---- Argon2id ----
  var argon2Impl = null; // test hook (not exported in the production bundle)
  function setArgon2(fn) { argon2Impl = fn || null; }
  // Captured once, at load time. In the bundle the build declares WDS_VENDOR_ARGON2 around this file (the vendored
  // hash-wasm runs in a private scope, so no global is read and no later script can replace it).
  var argon2Builtin = (function () {
    if (typeof WDS_VENDOR_ARGON2 === 'function') return WDS_VENDOR_ARGON2;
    if (!PRODUCTION && root.hashwasm && typeof root.hashwasm.argon2id === 'function') return root.hashwasm.argon2id;
    return null;
  })();
  function getArgon2(custom) {
    if (custom) return custom;
    if (!PRODUCTION && argon2Impl) return argon2Impl;
    if (argon2Builtin) return argon2Builtin;
    throw new WDSError('Argon2id implementation not found (hash-wasm build is not loaded)');
  }
  var KDF_WINDOW = { mMin: 65536, mMax: 262144, tMin: 3, tMax: 10 };
  var DEFAULT_KDF = { alg: 'argon2id', m: 65536, p: 1, t: 3, v: 19 };
  // Returns the descriptor (canonical copy) or throws IntegrityError. withSalt: salt required.
  function checkKdf(kdf, withSalt) {
    if (!kdf || typeof kdf !== 'object' || Array.isArray(kdf)) throw new IntegrityError('invalid KDF descriptor');
    if (kdf.alg === 'invite') {
      if (Object.keys(kdf).length !== 1) throw new IntegrityError('invalid invite KDF descriptor');
      return { alg: 'invite' };
    }
    var keys = Object.keys(kdf).sort().join(',');
    if (keys !== (withSalt === false ? 'alg,m,p,t,v' : 'alg,m,p,salt,t,v')) throw new IntegrityError('invalid KDF descriptor');
    if (kdf.alg !== 'argon2id' || kdf.v !== 19 || kdf.p !== 1 ||
        !Number.isInteger(kdf.m) || kdf.m < KDF_WINDOW.mMin || kdf.m > KDF_WINDOW.mMax ||
        !Number.isInteger(kdf.t) || kdf.t < KDF_WINDOW.tMin || kdf.t > KDF_WINDOW.tMax) {
      throw new IntegrityError('KDF parameters outside the accepted window', { code: 'weak_kdf' });
    }
    var out = { alg: 'argon2id', m: kdf.m, p: kdf.p, t: kdf.t, v: kdf.v };
    if (withSalt !== false) {
      b64uDecode(kdf.salt, 16);
      out.salt = kdf.salt;
    }
    return out;
  }
  async function argon2idKey(passphrase, kdf, impl) {
    if (typeof passphrase !== 'string' || passphrase.length === 0) throw new UsageError('passphrase required');
    kdf = checkKdf(kdf);
    var out = await getArgon2(impl)({
      password: utf8(passphrase.normalize('NFC')), salt: b64uDecode(kdf.salt, 16),
      parallelism: kdf.p, iterations: kdf.t, memorySize: kdf.m, hashLength: 32, outputType: 'binary',
    });
    return toBytes(out);
  }

  // ------------------------------------------------------------------------------------------------------------
  // 2. Envelopes, records, slot blobs, keyring entries
  // ------------------------------------------------------------------------------------------------------------
  var T_RECORD = 1, T_SLOT = 2, T_KEYRING = 3;
  // Records: the largest envelope any scope can hold (the 25 MiB ceiling of max_value_bytes, PROTOCOL 7.1). Reads and
  // re-encryption are bounded by this fixed value and never by the scope's current limit: an operator who lowers
  // max_value_bytes later must not make stored values unreadable (PLAN 8.3). The AEAD tag protects integrity anyway.
  var MAX_VALUE_CEILING = 26214400;
  var ENV_MIN = { 1: 38, 2: 38, 3: 103 }, ENV_MAX = { 1: padme(4 + 2048 + MAX_VALUE_CEILING) + 38, 2: 4096, 3: 16384 };
  function envHeader(type, epoch) {
    return new Uint8Array([0x57, 0x44, 0x53, 0x31, type, 0, (epoch >>> 24) & 255, (epoch >>> 16) & 255, (epoch >>> 8) & 255, epoch & 255]);
  }
  // Parse the outer structure; returns {type, epoch, header, nonce, eph, ct}.
  function parseEnvelope(b, wantType, maxLen) {
    if (!b || !ArrayBuffer.isView(b) || b.length < 10) throw new IntegrityError('malformed envelope', { code: 'malformed_envelope' });
    if (b[0] !== 0x57 || b[1] !== 0x44 || b[2] !== 0x53 || b[3] !== 0x31) throw new IntegrityError('bad envelope magic', { code: 'malformed_envelope' });
    var type = b[4];
    if (type !== wantType) throw new IntegrityError('unexpected envelope type', { code: 'malformed_envelope' });
    if (b[5] !== 0) throw new IntegrityError('unsupported envelope flags', { code: 'malformed_envelope' });
    var epoch = readU32(b, 6);
    var max = maxLen || ENV_MAX[type] || Infinity;
    if (b.length < ENV_MIN[type] || b.length > max) throw new IntegrityError('envelope length out of range', { code: 'malformed_envelope' });
    if (type !== T_RECORD && epoch !== 0) throw new IntegrityError('nonzero epoch in non-record envelope', { code: 'malformed_envelope' });
    var o = 10, eph = null;
    if (type === T_KEYRING) {
      eph = b.subarray(10, 75); o = 75;
      if (eph[0] !== 4) throw new IntegrityError('bad ephemeral key', { code: 'malformed_envelope' });
    }
    return { type: type, epoch: epoch, header: b.subarray(0, 10), eph: eph, nonce: b.subarray(o, o + 12), ct: b.subarray(o + 12) };
  }
  async function sealEnvelope(key, type, epoch, plaintext, aadTail, nonce, ephPub) {
    var H = envHeader(type, epoch);
    nonce = nonce || randomBytes(12);
    var ct = await aesSeal(key, nonce, plaintext, concat(H, aadTail));
    return concat(H, ephPub || EMPTY, nonce, ct);
  }
  async function openEnvelope(key, env, aadTail) {
    return aesOpen(key, env.nonce, env.ct, concat(env.header, aadTail));
  }

  // AAD tails (everything after the 10-byte header), PROTOCOL.md 4.2
  function aadRecord(scope, vault, rid, version) {
    return concat(lp(ascii(scope)), lp(ascii(vault)), lp(ascii(rid)), lp(u32(version)));
  }
  function aadSlot(scope, vault, accessId, kdf) {
    return concat(lp(ascii(scope)), lp(ascii(vault)), lp(ascii(accessId)), lp(cjsonBytes(kdf)));
  }
  function aadKeyring(scope, vault, slotId, rosterVersion, recipientPub) {
    return concat(lp(ascii(scope)), lp(ascii(vault)), lp(ascii(slotId)), lp(u32(rosterVersion)), lp(recipientPub));
  }

  // ---- derived keys (3.2) ----
  async function deriveSlotKeys(ikm) {
    var kWrap = await hkdf(ikm, EMPTY, 'wds1/slot-wrap');
    var token = await hkdf(ikm, EMPTY, 'wds1/slot-auth');
    return { kWrap: kWrap, token: token, tokenHash: await sha256(token) };
  }
  async function deriveVaultKeys(vmk, nk) {
    var out = {};
    if (vmk) {
      out.kEnc = await hkdf(vmk, EMPTY, 'wds1/record-enc');
      out.cVmk = await hkdf(vmk, EMPTY, 'wds1/check/vmk');
    }
    if (nk) {
      out.kId = await hkdf(nk, EMPTY, 'wds1/record-id');
      out.kCommit = await hkdf(nk, EMPTY, 'wds1/history-commit');
      out.kState = await hkdf(nk, EMPTY, 'wds1/local-state');
      out.cNk = await hkdf(nk, EMPTY, 'wds1/check/nk');
    }
    return out;
  }
  async function recordId(kId, name) { return b64u(await hmac(kId, utf8(name))); } // kId: raw bytes or HMAC CryptoKey
  async function commitment(kCommit, rid, version, plaintext) { // kCommit: raw bytes or HMAC CryptoKey
    var data = concat(lp(ascii(rid)), lp(u32(version)), lp(await sha256(plaintext)));
    return b64u(await hmac(kCommit, data));
  }
  function bearerHeader(accessId, token) { return 'Bearer wds1.' + accessId + '.' + b64u(token); }

  // ---- record names and plaintext (2, 4.4) ----
  function checkRecordName(name) {
    if (typeof name !== 'string' || name.length === 0) throw new UsageError('record name must be a non-empty string');
    for (var i = 0; i < name.length; i++) {
      var c = name.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff) {
        var d = name.charCodeAt(i + 1);
        if (!(d >= 0xdc00 && d <= 0xdfff)) throw new UsageError('record name contains a lone surrogate');
        i++;
      } else if (c >= 0xdc00 && c <= 0xdfff) throw new UsageError('record name contains a lone surrogate');
    }
    if (utf8(name).length > 1024) throw new UsageError('record name longer than 1024 bytes');
    return name;
  }
  function buildRecordPlaintext(name, kind, body, mime, time) {
    checkRecordName(name);
    if (kind !== 'json' && kind !== 'bytes') throw new UsageError('kind must be json or bytes');
    var hdr = { k: kind, l: body.length };
    if (mime !== undefined && mime !== null && mime !== '') {
      if (kind !== 'bytes') throw new UsageError('mime only applies to bytes records');
      if (utf8(mime).length > 255) throw new UsageError('mime type longer than 255 bytes');
      hdr.m = mime;
    }
    hdr.n = name;
    hdr.t = time;
    var hb = utf8(JSON.stringify(hdr));
    if (hb.length > 2048) throw new UsageError('record header larger than 2048 bytes');
    var used = 4 + hb.length + body.length;
    var pt = new Uint8Array(padme(used));
    pt.set(u32(hb.length), 0); pt.set(hb, 4); pt.set(body, 4 + hb.length);
    return { plaintext: pt, header: hdr, headerBytes: hb };
  }
  function parseRecordPlaintext(pt, expectName) {
    if (pt.length < 4) throw new IntegrityError('record plaintext too short');
    var hl = readU32(pt, 0);
    if (hl > 2048 || 4 + hl > pt.length) throw new IntegrityError('bad record header length');
    var hdr;
    try { hdr = JSON.parse(utf8Decode(pt.subarray(4, 4 + hl))); } catch (e) { throw new IntegrityError('bad record header'); }
    if (!hdr || typeof hdr !== 'object' || Array.isArray(hdr)) throw new IntegrityError('bad record header');
    if (expectName !== undefined && hdr.n !== expectName) throw new IntegrityError('record name mismatch');
    if (typeof hdr.n !== 'string') throw new IntegrityError('bad record header');
    if (hdr.k !== 'json' && hdr.k !== 'bytes') throw new IntegrityError('bad record kind');
    if (!Number.isInteger(hdr.l) || hdr.l < 0 || 4 + hl + hdr.l > pt.length) throw new IntegrityError('bad record body length');
    if (!Number.isInteger(hdr.t) || hdr.t < 0) throw new IntegrityError('bad record time');
    if (hdr.m !== undefined && typeof hdr.m !== 'string') throw new IntegrityError('bad record mime');
    for (var i = 4 + hl + hdr.l; i < pt.length; i++) if (pt[i] !== 0) throw new IntegrityError('nonzero padding');
    var body = pt.slice(4 + hl, 4 + hl + hdr.l);
    var value;
    if (hdr.k === 'json') {
      try { value = JSON.parse(utf8Decode(body)); } catch (e) { throw new IntegrityError('record body is not valid JSON'); }
    } else value = body;
    return { name: hdr.n, kind: hdr.k, mime: hdr.m === undefined ? null : hdr.m, time: hdr.t, value: value, body: body };
  }
  // Record envelope (type 0x01).
  async function sealRecord(o) { // {kEncRaw|key, epoch, scope, vault, rid, version, plaintext, nonce?}
    var key = o.key || await aesKey(o.kEncRaw);
    return sealEnvelope(key, T_RECORD, o.epoch, o.plaintext, aadRecord(o.scope, o.vault, o.rid, o.version), o.nonce);
  }
  async function openRecord(o) { // {key, envelope(bytes), scope, vault, rid, version, maxLen?} -> {plaintext, epoch}
    var env = parseEnvelope(o.envelope, T_RECORD, o.maxLen);
    var pt = await openEnvelope(o.key, env, aadRecord(o.scope, o.vault, o.rid, o.version));
    return { plaintext: pt, epoch: env.epoch };
  }

  // ---- slot blob (type 0x02, 3.3) ----
  function slotPlaintext(vault, slotId, keySets) {
    return cjsonBytes({
      keys: keySets.map(function (k) { return { e_d: b64u(k.e.d), e_pub: b64u(k.e.pub), s_d: b64u(k.s.d), s_pub: b64u(k.s.pub) }; }),
      slot: slotId, v: 1, vault: vault,
    });
  }
  async function wrapSlot(o) { // {kWrap (CryptoKey or raw bytes; kWrapRaw is the same), scope, vault, accessId, kdf, slotId, keySets, nonce?}
    var key = await aesKey(o.kWrap || o.kWrapRaw);
    return sealEnvelope(key, T_SLOT, 0, slotPlaintext(o.vault, o.slotId, o.keySets), aadSlot(o.scope, o.vault, o.accessId, o.kdf), o.nonce);
  }
  async function unwrapSlot(o) { // {kWrap (CryptoKey or raw bytes; kWrapRaw is the same), scope, vault, accessId, kdf, envelope} -> {slot, vault, keySets}
    var key = await aesKey(o.kWrap || o.kWrapRaw);
    var env = parseEnvelope(o.envelope, T_SLOT);
    var pt = await openEnvelope(key, env, aadSlot(o.scope, o.vault, o.accessId, o.kdf));
    var doc = cjsonParse(utf8Decode(pt));
    if (doc.v !== 1) throw new VersionError('unknown slot blob format version');
    if (Object.keys(doc).join(',') !== 'keys,slot,v,vault') throw new IntegrityError('bad slot blob');
    if (!Array.isArray(doc.keys) || doc.keys.length < 1 || doc.keys.length > 2) throw new IntegrityError('bad slot blob keys');
    var sets = doc.keys.map(function (k) {
      if (Object.keys(k).join(',') !== 'e_d,e_pub,s_d,s_pub') throw new IntegrityError('bad slot key set');
      var s = { e: { d: b64uDecode(k.e_d, 32), pub: b64uDecode(k.e_pub, 65) }, s: { d: b64uDecode(k.s_d, 32), pub: b64uDecode(k.s_pub, 65) } };
      checkPub(s.e.pub); checkPub(s.s.pub);
      return s;
    });
    return { slot: doc.slot, vault: doc.vault, keySets: sets };
  }

  // ---- keyring entry (ECIES, type 0x03, 4.3) ----
  async function eciesSeal(o) { // {recipientPub, plaintext(bytes), aadTail, eph?: {d,pub}, nonce?} -> envelope
    checkPub(o.recipientPub);
    var eph = o.eph || await generateKeyPair('E');
    var ephPriv = await importPrivate('E', eph.d, eph.pub);
    var z = await ecdh(ephPriv, o.recipientPub);
    var k = await aesKey(await hkdf(z, concat(eph.pub, o.recipientPub), 'wds1/ecies'));
    return sealEnvelope(k, T_KEYRING, 0, o.plaintext, o.aadTail, o.nonce, eph.pub);
  }
  async function eciesOpen(o) { // {recipientPriv(CryptoKey), recipientPub, envelope(bytes), aadTail} -> plaintext
    var env = parseEnvelope(o.envelope, T_KEYRING);
    var z = await ecdh(o.recipientPriv, env.eph);
    var k = await aesKey(await hkdf(z, concat(env.eph, o.recipientPub), 'wds1/ecies'));
    return openEnvelope(k, env, o.aadTail);
  }
  function keyringPlaintext(epochs, nk) { // epochs: [{e, k(bytes)}]
    var list = epochs.slice().sort(function (a, b) { return a.e - b.e; }).map(function (x) { return { e: x.e, k: b64u(x.k) }; });
    return cjsonBytes({ epochs: list, nk: b64u(nk), v: 1 });
  }
  function parseKeyringPlaintext(pt) {
    var doc = cjsonParse(utf8Decode(pt));
    if (doc.v !== 1) throw new VersionError('unknown keyring format version');
    if (Object.keys(doc).join(',') !== 'epochs,nk,v' || !Array.isArray(doc.epochs)) throw new IntegrityError('bad keyring entry');
    var last = 0, epochs = doc.epochs.map(function (x) {
      if (Object.keys(x).join(',') !== 'e,k' || !Number.isInteger(x.e) || x.e <= last) throw new IntegrityError('bad keyring epoch list');
      last = x.e;
      return { e: x.e, k: b64uDecode(x.k, 32) };
    });
    return { epochs: epochs, nk: b64uDecode(doc.nk, 32) };
  }

  // ---- identities ----
  async function vaultIdFromPub(sPub) { return plainCrockford(await sha256(sPub), 26); }
  async function escrowKeyId(ePub, sPub) { return b64u(await sha256(concat(ePub, sPub))); }
  function randomSlotId() { return b64u(randomBytes(12)); }
  async function randomAccessId() { return b32cEncode(randomBytes(12)); }
  var RE_ACCESS = /^[0-9A-HJKMNP-TV-Z]{20}$/, RE_VAULT = /^[0-9A-HJKMNP-TV-Z]{26}$/, RE_SLOT = /^[A-Za-z0-9_-]{16}$/;
  async function checkAccessId(id) {
    if (typeof id !== 'string' || !RE_ACCESS.test(id)) throw new UsageError('invalid access ID', { code: 'invalid_code' });
    await b32cDecode(id, 12);
    return id;
  }

  // ---- local state MAC (7.4) ----
  // The MACed state names the scope, vault, access ID and slot it belongs to (the caller checks them after opening), so a
  // state blob copied from another member of the same vault or from another vault is not accepted. The MAC does not
  // prove freshness: local code that can write localStorage can put back an older genuine blob of the same slot.
  async function sealState(kState, state) { // kState: raw bytes or HMAC CryptoKey
    var mac = b64u(await hmac(kState, cjsonBytes(state)));
    return cjson({ mac: mac, state: state });
  }
  async function openState(kState, text) { // -> state or null
    try {
      var doc = cjsonParse(text);
      if (Object.keys(doc).join(',') !== 'mac,state') return null;
      var mac = b64uDecode(doc.mac, 32);
      if (!bytesEqual(mac, await hmac(kState, cjsonBytes(doc.state)))) return null;
      return doc.state;
    } catch (e) { return null; }
  }

  // ------------------------------------------------------------------------------------------------------------
  // 3. Roster (6): building, signing, chain verification
  // ------------------------------------------------------------------------------------------------------------
  var ROSTER_KEYS = 'commit,epoch,prev,scope,signer,slots,time,type,v,vault,version';
  var SLOT_KEYS = 'e_pub,expires,id,kind,role,s_pub';
  async function rosterHash(body) { return b64u(await sha256(cjsonBytes(body))); }
  async function signRoster(body, sPrivKey) {
    return { body: body, sig: b64u(await ecdsaSign(sPrivKey, cjsonBytes(body))) };
  }
  function cloneJson(x) { return JSON.parse(JSON.stringify(x)); }
  function commitmentFor(body, epoch) {
    for (var i = 0; i < body.commit.epochs.length; i++) if (body.commit.epochs[i].e === epoch) return body.commit.epochs[i].c;
    return null;
  }
  function findSlot(body, id) {
    for (var i = 0; i < body.slots.length; i++) if (body.slots[i].id === id) return body.slots[i];
    return null;
  }
  function isInt(x) { return Number.isSafeInteger(x) && x >= 0; }

  function checkRosterShape(body, expect) {
    function bad(m) { throw new IntegrityError('invalid roster: ' + m, { code: 'invalid_roster' }); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) bad('not an object');
    if (body.v !== 1) throw new VersionError('unknown roster format version');
    if (Object.keys(body).sort().join(',') !== ROSTER_KEYS) bad('unexpected keys');
    if (body.type !== 'roster') bad('wrong type');
    if (body.scope !== expect.scope || body.vault !== expect.vault) bad('scope or vault mismatch');
    if (!isInt(body.version) || body.version < 1 || !isInt(body.epoch) || body.epoch < 1 || !isInt(body.time)) bad('bad numbers');
    if (typeof body.prev !== 'string' || (body.prev !== '' && body.prev.length !== 43)) bad('bad prev');
    if (!RE_SLOT.test(body.signer)) bad('bad signer');
    var c = body.commit;
    if (!c || typeof c !== 'object' || Object.keys(c).sort().join(',') !== 'epochs,nk' || !Array.isArray(c.epochs)) bad('bad commit');
    b64uDecode(c.nk, 32);
    var last = 0, hasCur = false;
    c.epochs.forEach(function (x) {
      if (!x || Object.keys(x).sort().join(',') !== 'c,e' || !isInt(x.e)) bad('bad commit entry');
      if (x.e <= last || x.e > body.epoch) bad('commit epochs not ascending or above epoch');
      last = x.e; if (x.e === body.epoch) hasCur = true;
      b64uDecode(x.c, 32);
    });
    if (!hasCur) bad('commit lacks current epoch');
    if (!Array.isArray(body.slots) || body.slots.length < 2 || body.slots.length > 64) bad('bad slot count');
    var prevId = null, esc = 0, owners = 0;
    body.slots.forEach(function (s) {
      if (!s || typeof s !== 'object' || Object.keys(s).sort().join(',') !== SLOT_KEYS) bad('bad slot entry');
      if (!RE_SLOT.test(s.id)) bad('bad slot id');
      if (prevId !== null && !(s.id > prevId)) bad('slots not sorted or duplicate');
      prevId = s.id;
      if (['passphrase', 'invite', 'escrow'].indexOf(s.kind) < 0 || ['owner', 'write', 'read'].indexOf(s.role) < 0) bad('bad kind or role');
      checkPub(b64uDecode(s.e_pub, 65)); checkPub(b64uDecode(s.s_pub, 65));
      if (s.kind === 'invite') { if (!isInt(s.expires)) bad('invite without expiry'); } else if (s.expires !== null) bad('expiry on non-invite');
      if (s.kind === 'escrow') { esc++; if (s.role !== 'owner') bad('escrow must be owner'); }
      if (s.role === 'owner' && s.kind !== 'escrow') owners++;
    });
    if (esc !== 1) bad('exactly one escrow slot required');
    if (owners < 1) bad('no owner slot');
    if (cjson(body).length > 65536) bad('roster too large');
  }
  function bodyEscrow(body) {
    for (var i = 0; i < body.slots.length; i++) if (body.slots[i].kind === 'escrow') return body.slots[i];
    return null;
  }

  // Escrow key IDs in rosters: every version of the chain must name an escrow key set that this library pins (current or
  // spare: "active") or that it lists as retired. Retired sets are valid for history only: an escrow-signed version
  // counts only if its time is not after the retirement ("until", Unix seconds). Whether the head still names a retired
  // set is the caller's business (an owner replaces it, see Client._migrateEscrow).
  function escrowStatus(o, id) {
    if (o.escrowPins.indexOf(id) >= 0) return { state: 'active' };
    var r = o.retiredEscrow || [];
    for (var i = 0; i < r.length; i++) if (r[i].id === id) return { state: 'retired', until: r[i].until };
    return null;
  }
  async function bodyEscrowId(body) {
    var esc = bodyEscrow(body);
    return escrowKeyId(b64uDecode(esc.e_pub), b64uDecode(esc.s_pub));
  }

  // docs: array of {body, sig} for consecutive versions; prior: {body, hash} of the last verified version or null.
  // Returns [{body, hash, sig, signedByEscrow, escrowId}] for the new versions.
  async function verifyRosterChain(o) { // {scope, vault, escrowPins, retiredEscrow?, docs, prior}
    var out = [], prev = o.prior || null, prevEscId = prev ? (prev.escrowId || await bodyEscrowId(prev.body)) : null;
    for (var di = 0; di < o.docs.length; di++) {
      var doc = o.docs[di];
      if (!doc || typeof doc !== 'object' || typeof doc.sig !== 'string') throw new IntegrityError('malformed roster document');
      var body = doc.body;
      checkRosterShape(body, o);
      var fail = function (m) { throw new IntegrityError('roster version ' + body.version + ': ' + m, { code: 'invalid_roster' }); };
      var escId = await bodyEscrowId(body);
      if (!escrowStatus(o, escId)) fail('escrow keys are not pinned by this library');
      var hash = await rosterHash(body), sigBytes = b64uDecode(doc.sig, 64), signerPub, escrowSigned = false;
      if (!prev) {
        if (body.version !== 1 || body.prev !== '' || body.epoch !== 1) fail('first version must be version 1, epoch 1, empty prev');
        if (body.slots.length !== 2) fail('version 1 must contain exactly the founder and escrow');
        var fs = findSlot(body, body.signer);
        if (!fs || fs.kind !== 'passphrase' || fs.role !== 'owner') fail('signer of version 1 must be the founder owner slot');
        signerPub = b64uDecode(fs.s_pub);
        if ((await vaultIdFromPub(signerPub)) !== body.vault) fail('vault ID does not match the founder key');
      } else {
        var P = prev.body;
        if (body.version !== P.version + 1) fail('version number does not continue the chain');
        if (body.prev !== prev.hash) fail('prev hash does not match');
        if (body.epoch !== P.epoch && body.epoch !== P.epoch + 1) fail('epoch may only stay or grow by one');
        var ps = findSlot(P, body.signer);
        if (!ps || ps.role !== 'owner') fail('signer was not an owner in the previous version');
        signerPub = b64uDecode(ps.s_pub);
        escrowSigned = ps.kind === 'escrow';
        if (escrowSigned) {
          var signerStatus = escrowStatus(o, prevEscId);
          if (!signerStatus) fail('escrow keys are not pinned by this library');
          if (signerStatus.state === 'retired' && !(body.time <= signerStatus.until)) fail('signed by a retired escrow key after its retirement');
        }
        checkRosterTransition(P, body, escrowSigned, fail);
      }
      if (!(await ecdsaVerify(signerPub, sigBytes, cjsonBytes(body)))) fail('invalid signature');
      var rec = { body: body, sig: doc.sig, hash: hash, signedByEscrow: escrowSigned, escrowId: escId };
      out.push(rec);
      prev = rec; prevEscId = escId;
    }
    return out;
  }
  function checkRosterTransition(P, N, escrowSigned, fail) {
    var i, s, p;
    // commitments of surviving epochs never change; new epochs only via an epoch bump
    if (N.commit.nk !== P.commit.nk) fail('name key commitment changed');
    N.commit.epochs.forEach(function (x) {
      var old = commitmentFor(P, x.e);
      if (old === null) { if (x.e !== N.epoch || N.epoch !== P.epoch + 1) fail('commitment for an epoch that was not created by this version'); }
      else if (old !== x.c) fail('epoch commitment changed');
    });
    // The escrow slot keeps its slot ID (PROTOCOL 6.2, 6.3): it is never replaced by a slot with another ID or removed.
    var pEsc = bodyEscrow(P), nEsc = bodyEscrow(N);
    if (!pEsc || !nEsc || nEsc.id !== pEsc.id) fail('the escrow slot must keep its slot ID');
    var newIds = [];
    for (i = 0; i < N.slots.length; i++) {
      s = N.slots[i]; p = findSlot(P, s.id);
      if (!p) {
        newIds.push(s.id);
        if (s.kind !== 'invite') fail('new slots must be invites');
        if (s.role === 'owner' && !escrowSigned) fail('owner invites may only be added by escrow');
        if (s.role !== 'owner' && s.role !== 'write' && s.role !== 'read') fail('bad role');
        continue;
      }
      if (p.kind === 'escrow') { if (s.kind !== 'escrow') fail('escrow slot changed kind'); continue; }
      if (s.kind !== p.kind && !(p.kind === 'invite' && s.kind === 'passphrase')) fail('illegal kind change');
      if (s.role !== p.role) {
        if (p.role === 'owner' || s.role === 'owner') fail('owner roles never change');
      }
      if (s.kind === 'passphrase' && p.kind === 'invite' && s.expires !== null) fail('expiry must be cleared');
      if (s.kind === p.kind && s.expires !== p.expires) fail('expiry cannot change');
      if (p.role === 'owner' && (s.e_pub !== p.e_pub || s.s_pub !== p.s_pub) && N.signer !== p.id && !escrowSigned) fail('only an owner may change its own keys');
    }
    for (i = 0; i < P.slots.length; i++) {
      p = P.slots[i];
      if (findSlot(N, p.id)) continue;
      if (p.kind === 'escrow') continue;
      if (N.epoch !== P.epoch + 1 && p.kind !== 'invite') fail('slot removed without epoch change');
    }
    if (escrowSigned) {
      if (newIds.length !== 1 || N.slots.length !== P.slots.length + 1 || N.epoch !== P.epoch || N.commit.epochs.length !== P.commit.epochs.length) fail('escrow may only add exactly one owner invite');
      if (findSlot(N, newIds[0]).role !== 'owner') fail('escrow may only add an owner invite');
      for (i = 0; i < P.slots.length; i++) {
        p = P.slots[i]; s = findSlot(N, p.id);
        if (!s || s.e_pub !== p.e_pub || s.s_pub !== p.s_pub || s.role !== p.role || s.kind !== p.kind || s.expires !== p.expires) fail('escrow changed existing slots');
      }
    }
  }

  // ------------------------------------------------------------------------------------------------------------
  // 4. Codes
  // ------------------------------------------------------------------------------------------------------------
  async function makeInviteCode(accessIdBytes, secret) {
    var canonical = (await b32cEncode(accessIdBytes)) + (await b32cEncode(secret));
    return { canonical: canonical, display: displayCode(canonical) };
  }
  async function parseInviteCode(input) {
    var s = normalizeCode(input);
    if (s.length !== 48) throw new UsageError('invite code must have 48 symbols', { code: 'invalid_code' });
    var idBytes = await b32cDecode(s.slice(0, 20), 12), secret = await b32cDecode(s.slice(20), 17);
    return { accessId: s.slice(0, 20), secret: secret, idBytes: idBytes };
  }
  async function makeRecoveryCode(bytes) {
    bytes = bytes || randomBytes(17);
    var canonical = await b32cEncode(bytes);
    return { bytes: bytes, canonical: canonical, display: displayCode(canonical), hash: b64u(await sha256(bytes)) };
  }
  async function parseRecoveryCode(input) {
    var s = normalizeCode(input);
    var bytes = await b32cDecode(s, 17);
    return { bytes: bytes, canonical: s, display: displayCode(s), hash: b64u(await sha256(bytes)) };
  }
  // Classify user input by length: 20 access ID, 48 invite code, 28 recovery code.
  function classifyCode(input) {
    var s;
    try { s = normalizeCode(input); } catch (e) { return 'unknown'; }
    return s.length === 20 ? 'access_id' : s.length === 48 ? 'invite' : s.length === 28 ? 'recovery' : 'unknown';
  }

  // ------------------------------------------------------------------------------------------------------------
  // 6. Protocol client
  // ------------------------------------------------------------------------------------------------------------
  function memoryStorage() {
    var m = new Map();
    return {
      getItem: function (k) { return m.has(k) ? m.get(k) : null; },
      setItem: function (k, v) { m.set(k, String(v)); },
      removeItem: function (k) { m.delete(k); },
    };
  }
  function defaultStorage() {
    try { if (root.localStorage) return root.localStorage; } catch (e) { /* access denied */ }
    return memoryStorage();
  }
  function last(a) { return a[a.length - 1]; }
  async function pool(items, n, fn) {
    var i = 0, results = new Array(items.length);
    async function worker() {
      while (i < items.length) { var k = i++; results[k] = await fn(items[k], k); }
    }
    var ws = [];
    for (var w = 0; w < Math.min(n, items.length); w++) ws.push(worker());
    await Promise.all(ws);
    return results;
  }
  var RE_SCOPE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*-[0-9a-hjkmnp-tv-z]{6}$/;

  // Build one keyring entry per slot of roster body (6.4). vmkMap: epoch -> 32 bytes.
  async function makeKeyring(scope, body, vmkMap, nk) {
    var epochs = body.commit.epochs.map(function (x) {
      var k = vmkMap.get(x.e);
      if (!k) throw new WDSError('missing key for committed epoch ' + x.e);
      return { e: x.e, k: k };
    });
    var plaintext = keyringPlaintext(epochs, nk), out = {};
    for (var i = 0; i < body.slots.length; i++) {
      var sl = body.slots[i], pub = b64uDecode(sl.e_pub, 65);
      out[sl.id] = b64u(await eciesSeal({ recipientPub: pub, plaintext: plaintext, aadTail: aadKeyring(scope, body.vault, sl.id, body.version, pub) }));
    }
    return out;
  }

  function Client(opts) {
    opts = opts || {};
    if (!RE_SCOPE.test(opts.scope || '')) throw new UsageError('invalid scope ID');
    this.scope = opts.scope;
    var service = opts.service || SERVICE_URL;
    this.service = service.slice(-1) === '/' ? service : service + '/';
    this.apiBase = this.service + 'api/v1';
    var f = opts.fetch || root.fetch;
    if (typeof f !== 'function') throw new WDSError('no fetch implementation available');
    this.fetch = opts.fetch ? opts.fetch : f.bind(root);
    this._defaultFetch = !opts.fetch;   // only the browser's own fetch gets an AbortSignal (an injected one is raced against the timeout only)
    this.storage = opts.storage || defaultStorage();
    this.now = opts.now || function () { return Date.now(); };
    this.argon2 = opts.argon2 || null;
    this.timeoutMs = opts.timeout === undefined ? Math.max(0, Number(Client.defaultTimeout) || 0) : Math.max(0, Number(opts.timeout) || 0);
    // A build that pins escrow keys ignores the options: app code cannot replace the pinned faculty escrow keys.
    if (BUILTIN_ESCROW_PINS.length) {
      if ((opts.escrowPins || opts.retiredEscrow) && typeof console !== 'undefined' && console.warn) console.warn('wds: the escrowPins and retiredEscrow options are ignored by a library build with pinned escrow keys');
      this.escrowPins = BUILTIN_ESCROW_PINS; this.retiredEscrow = BUILTIN_RETIRED_ESCROW;
    } else {
      this.escrowPins = opts.escrowPins || []; this.retiredEscrow = opts.retiredEscrow || [];
    }
    this.s = null;
    this._scopeInfo = null;
  }
  Client.defaultTimeout = 30000;   // ms; see the option "timeout"
  var CP = Client.prototype;

  // ---- HTTP ----
  CP._auth = function () {
    if (!this.s) throw new UsageError('locked: unlock the vault first', { code: 'locked' });
    return { accessId: this.s.accessId, token: this.s.token };
  };
  CP._req = async function (method, path, o) {
    o = o || {};
    var headers = Object.assign({}, o.headers), body = o.body;
    if (o.auth) headers.Authorization = bearerHeader(o.auth.accessId, o.auth.token);
    if (o.json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(o.json); }
    var res, init = { method: method, headers: headers, body: body }, ctl = null;
    if (this.timeoutMs > 0 && typeof AbortController === 'function' && this._defaultFetch) { ctl = new AbortController(); init.signal = ctl.signal; }
    var sent = body && typeof body.byteLength === 'number' ? body.byteLength : body && typeof body.length === 'number' ? body.length : 0;
    try { res = await this._within(this.fetch(this.apiBase + path, init), sent, ctl, o.timeout); }
    catch (e) {
      if (e instanceof OfflineError) throw e;
      throw new OfflineError('network error: ' + (e && e.message ? e.message : e), { cause: e });
    }
    if (res.ok) return res;
    throw await this._httpError(res);
  };
  // Waits for a promise (the answer of a request, or the reading of its body) for at most the timeout (ms: a number replaces the client's
  // timeout for this call, 0 = no limit); "bytes" (an upload or a body of known size) adds one second per 10 KB. A request that does not
  // answer in time is aborted and fails with an OfflineError.
  CP._within = function (promise, bytes, ctl, ms) {
    if (typeof ms !== 'number') ms = this.timeoutMs;
    if (!(ms > 0)) return promise;
    ms += Math.floor((bytes || 0) / 10000) * 1000;
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () {
        if (ctl) { try { ctl.abort(); } catch (e) { /* already done */ } }
        reject(new OfflineError('network error: no answer within ' + Math.round(ms / 1000) + ' s', { code: 'timeout' }));
      }, ms);
      if (timer && typeof timer === 'object' && typeof timer.unref === 'function') timer.unref();   // Node: a pending request timer must not keep a process alive
      promise.then(function (v) { clearTimeout(timer); resolve(v); }, function (e) { clearTimeout(timer); reject(e); });
    });
  };
  // The time for the two requests that decide about a whole vault (create, redeem): the answer may take longer, and one that is lost after the
  // server has committed cannot be recovered by the client, so it is better to wait than to give up early.
  CP._patientMs = function () { return this.timeoutMs > 0 ? this.timeoutMs * 3 : 0; };
  CP._json = async function (method, path, o) {
    var res = await this._req(method, path, o);
    try { return await this._within(res.json()); }
    catch (e) { if (e instanceof OfflineError) throw e; throw new IntegrityError('server sent invalid JSON'); }
  };
  CP._httpError = async function (res) {
    var b = null;
    try { b = await this._within(res.json()); } catch (e) { /* no body */ }
    var code = b && typeof b.error === 'string' ? b.error : null;
    var msg = (b && typeof b.message === 'string' ? b.message : 'HTTP ' + res.status) + (code ? ' (' + code + ')' : '');
    var props = { status: res.status, code: code, body: b, retryAfter: res.headers && res.headers.get ? res.headers.get('Retry-After') : null };
    var st = res.status;
    if (st === 401 || (st === 403 && code === 'forbidden') || st === 410) return new AuthError(msg, props);
    if (st === 412) return new ConflictError(msg, props);
    if (st === 413 || st === 507 || (st === 503 && code === 'read_only')) return new QuotaError(msg, props);
    return new RequestError(msg, props);
  };

  // ---- scope and escrow ----
  CP.getScopeInfo = async function (force) {
    if (this._scopeInfo && !force) return this._scopeInfo;
    var info = await this._json('GET', '/scopes/' + this.scope);
    if (!info || info.scope !== this.scope) throw new IntegrityError('scope information does not match');
    checkKdf(info.kdf, false);
    this._scopeInfo = info;
    return info;
  };
  CP._pickEscrow = async function (info) {
    if (!this.escrowPins.length) throw new WDSError('no escrow key IDs are pinned in this build of the library');
    var cur = (info.escrow || []).filter(function (x) { return x.status === 'current'; })[0];
    if (!cur) throw new IntegrityError('server offers no current escrow keys');
    var e = b64uDecode(cur.e_pub, 65), sp = b64uDecode(cur.s_pub, 65);
    checkPub(e); checkPub(sp);
    var id = await escrowKeyId(e, sp);
    if (id !== cur.id || this.escrowPins.indexOf(id) < 0) throw new IntegrityError('escrow keys offered by the server are not pinned', { code: 'escrow_not_pinned' });
    return { e_pub: cur.e_pub, s_pub: cur.s_pub, id: id };
  };
  CP._freshKdf = async function () {
    var info = await this.getScopeInfo();
    var k = checkKdf(info.kdf, false);
    k.salt = b64u(randomBytes(16));
    return checkKdf(k);
  };

  // ---- remembered access ID (not secret) ----
  // Stored as JSON {id, t}: t is the time (ms) the ID was first remembered on this device (creation or redemption), so a
  // sandbox can tell that the vault behind the ID was deleted by a nightly wipe.
  CP.rememberedAccess = function () {
    var raw = this.storage.getItem('wds:' + this.scope + ':access_id'), v = null;
    try { v = raw ? JSON.parse(raw) : null; } catch (e) { return null; }
    return v && typeof v === 'object' && typeof v.id === 'string' && RE_ACCESS.test(v.id) && Number.isFinite(v.t) ? { id: v.id, t: v.t } : null;
  };
  CP.rememberedAccessId = function () { var a = this.rememberedAccess(); return a ? a.id : null; };
  // t is when this device first remembered the ID (the creation or the redemption of the vault), not the last unlock: a sandbox
  // compares it with the last nightly wipe to see whether the vault is gone.
  CP.rememberAccessId = function (id) {
    var old = this.rememberedAccess();
    this.storage.setItem('wds:' + this.scope + ':access_id', JSON.stringify({ id: id, t: old && old.id === id ? old.t : this.now() }));
  };
  CP.forgetAccessId = function () { this.storage.removeItem('wds:' + this.scope + ':access_id'); };

  // ---- create vault ----
  CP.createVault = async function (o) { // {passphrase, joinCode?}
    var info = await this.getScopeInfo();
    var escrow = await this._pickEscrow(info);
    var kdf = await this._freshKdf();
    var kek = await argon2idKey(o.passphrase, kdf, this.argon2);
    for (var attempt = 0; ; attempt++) {
      try { return await this._createVaultOnce(escrow, kdf, kek, o); }
      catch (e) {
        if (e && e.status === 409 && ['vault_exists', 'access_id_taken', 'slot_id_taken'].indexOf(e.code) >= 0 && attempt < 3) continue;
        throw e;
      }
    }
  };
  CP._createVaultOnce = async function (escrow, kdf, kek, o) {
    var scope = this.scope;
    var fE = await generateKeyPair('E'), fS = await generateKeyPair('S');
    var vaultId = await vaultIdFromPub(fS.pub);
    var founderSlot = randomSlotId(), escrowSlot = randomSlotId();
    var accessId = await randomAccessId();
    var vmk1 = randomBytes(32), nk = randomBytes(32);
    var dk = await deriveVaultKeys(vmk1, nk);
    var rec = await makeRecoveryCode();
    var sk = await deriveSlotKeys(kek);
    var wrapped = await wrapSlot({ kWrapRaw: sk.kWrap, scope: scope, vault: vaultId, accessId: accessId, kdf: kdf, slotId: founderSlot, keySets: [{ e: fE, s: fS }] });
    var body = {
      commit: { epochs: [{ c: b64u(dk.cVmk), e: 1 }], nk: b64u(dk.cNk) }, epoch: 1, prev: '', scope: scope, signer: founderSlot,
      slots: [
        { e_pub: b64u(fE.pub), expires: null, id: founderSlot, kind: 'passphrase', role: 'owner', s_pub: b64u(fS.pub) },
        { e_pub: escrow.e_pub, expires: null, id: escrowSlot, kind: 'escrow', role: 'owner', s_pub: escrow.s_pub },
      ].sort(function (a, b) { return a.id < b.id ? -1 : 1; }),
      time: Math.floor(this.now() / 1000), type: 'roster', v: 1, vault: vaultId, version: 1,
    };
    var roster = await signRoster(body, await importPrivate('S', fS.d, fS.pub));
    var keyring = await makeKeyring(scope, body, new Map([[1, vmk1]]), nk);
    var req = {
      vault: vaultId, roster: roster,
      slots: [{ slot: founderSlot, access_id: accessId, kdf: kdf, token_hash: b64u(sk.tokenHash), wrapped: b64u(wrapped) }],
      keyring: keyring, recovery_hash: rec.hash,
      join_code: o.joinCode || null,
    };
    await this._json('POST', '/scopes/' + scope + '/vaults', { json: req, timeout: this._patientMs() });
    await this._openSession({ accessId: accessId, ikm: kek, kdf: kdf, expectedVault: vaultId });
    this.rememberAccessId(accessId);
    return {
      accessId: accessId, accessIdDisplay: displayCode(accessId), vaultId: vaultId,
      recoveryCode: { canonical: rec.canonical, display: rec.display }, role: 'owner',
    };
  };

  // ---- unlock ----
  CP.unlock = async function (o) { // {accessId, passphrase, maintain?}
    var accessId = await checkAccessId(typeof o.accessId === 'string' ? normalizeCode(o.accessId) : o.accessId);
    var k = await this._json('GET', '/slots/' + accessId + '/kdf');
    if (k.kind === 'invite') throw new UsageError('this ID belongs to an unredeemed invite; use redeemInvite', { code: 'invite_not_redeemed' });
    var kdf = checkKdf(k.kdf);
    var kek = await argon2idKey(o.passphrase, kdf, this.argon2);
    await this._openSession({ accessId: accessId, ikm: kek, kdf: kdf, maintain: o.maintain });
    this.rememberAccessId(accessId);
    return this.status();
  };
  CP.lock = function () { this.s = null; };

  CP._openSession = async function (o) {
    var sk = await deriveSlotKeys(o.ikm);
    this.s = {
      accessId: o.accessId, token: sk.token, tokenHash: sk.tokenHash, kWrap: await aesKey(sk.kWrap), kdf: o.kdf, expectedVault: o.expectedVault || null,
      vaultId: null, slotId: null, chain: [], head: null, epoch: 0, role: null, kind: null, sv: 0, wrappedStr: null,
      keySets: null, activeIdx: 0, ePriv: null, sPriv: null,
      vmk: new Map(), nk: null, keys: null, encKeys: new Map(),
      pin: { rv: 0, head: '', epoch: 0 }, stateLoaded: false, stateStatus: null,
      seen: new Map(), known: new Map(), nameCache: new Map(), listed: new Map(), listedBytes: 0, persistChain: Promise.resolve(),
      serverSlots: {}, recovery: null, recoveredSlots: [], recoveryAck: false, rekeyPending: false, warnings: [],
    };
    try {
      await this._syncHead();
      if (o.maintain !== false) await this._maintain();
    } catch (e) { this.s = null; throw e; }
  };

  // Reload slot, roster and keyring, verify everything (called on unlock, after epoch changes and before roster edits).
  CP._syncHead = async function () {
    var s = this.s, scope = this.scope;
    for (var attempt = 0; attempt < 4; attempt++) {
      var auth = this._auth();
      var slotRes = await this._json('GET', '/slots/' + s.accessId, { auth: auth });
      if (slotRes.access_id !== s.accessId || slotRes.scope !== scope || typeof slotRes.vault !== 'string' || !RE_VAULT.test(slotRes.vault)) throw new IntegrityError('slot response does not match the request');
      if (s.expectedVault && s.expectedVault !== slotRes.vault) throw new IntegrityError('vault ID differs from the expected one', { code: 'vault_mismatch' });
      if (s.vaultId && s.vaultId !== slotRes.vault) throw new IntegrityError('vault ID changed');
      if (cjson(checkKdf(slotRes.kdf)) !== cjson(s.kdf)) throw new IntegrityError('server changed the KDF descriptor');
      var vaultId = slotRes.vault;
      // unwrap (first time, or when the blob changed)
      var keySets = s.keySets;
      if (s.wrappedStr !== slotRes.wrapped) {
        var blob = await unwrapSlot({ kWrap: s.kWrap, scope: scope, vault: vaultId, accessId: s.accessId, kdf: s.kdf, envelope: b64uDecode(slotRes.wrapped) });
        if (blob.vault !== vaultId || blob.slot !== slotRes.slot) throw new IntegrityError('slot blob belongs to a different slot or vault');
        keySets = blob.keySets;
      }
      // roster
      var prior = s.chain.length ? last(s.chain) : null, since = prior ? prior.body.version : 0;
      var rr = await this._json('GET', '/vaults/' + vaultId + '/roster' + (since ? '?since=' + since : ''), { auth: auth });
      if (!rr || !Array.isArray(rr.versions) || !isInt(rr.head)) throw new IntegrityError('bad roster response');
      if (rr.head < since) throw new IntegrityError('roster rolled back by the server', { code: 'rollback' });
      var added = await verifyRosterChain({ scope: scope, vault: vaultId, escrowPins: this.escrowPins, retiredEscrow: this.retiredEscrow, docs: rr.versions, prior: prior });
      var chain = s.chain.concat(added), head = last(chain);
      if (!head || head.body.version !== rr.head || head.hash !== rr.head_hash) throw new IntegrityError('roster head does not match the verified chain', { code: 'rollback' });
      if (!slotRes.keyring || !isInt(slotRes.keyring.rv) || typeof slotRes.keyring.entry !== 'string') throw new IntegrityError('the server has no keyring entry for this slot', { code: 'keyring_mismatch' });
      if (slotRes.keyring.rv !== head.body.version) continue; // roster changed between the two requests
      // my entry and key set
      var entry = findSlot(head.body, slotRes.slot);
      if (!entry) throw new AuthError('this slot is no longer part of the vault', { code: 'revoked' });
      var idx = -1;
      for (var i = 0; i < keySets.length; i++) if (b64u(keySets[i].e.pub) === entry.e_pub && b64u(keySets[i].s.pub) === entry.s_pub) idx = i;
      if (idx < 0) throw new IntegrityError('slot keys do not match the signed roster', { code: 'keys_mismatch' });
      var ePub = keySets[idx].e.pub;
      var ePriv = await importPrivate('E', keySets[idx].e.d, ePub), sPriv = await importPrivate('S', keySets[idx].s.d, keySets[idx].s.pub);
      var plain = await eciesOpen({ recipientPriv: ePriv, recipientPub: ePub, envelope: b64uDecode(slotRes.keyring.entry), aadTail: aadKeyring(scope, vaultId, slotRes.slot, head.body.version, ePub) });
      var kr = parseKeyringPlaintext(plain);
      var wantEpochs = head.body.commit.epochs;
      if (kr.epochs.length !== wantEpochs.length) throw new IntegrityError('keyring entry does not list the committed epochs', { code: 'keyring_mismatch' });
      var vmk = new Map();
      for (var j = 0; j < wantEpochs.length; j++) {
        if (kr.epochs[j].e !== wantEpochs[j].e) throw new IntegrityError('keyring epochs differ from the roster', { code: 'keyring_mismatch' });
        var cv = b64u(await hkdf(kr.epochs[j].k, EMPTY, 'wds1/check/vmk'));
        if (cv !== wantEpochs[j].c) throw new IntegrityError('keyring entry fails the roster commitment', { code: 'keyring_mismatch' });
        vmk.set(kr.epochs[j].e, kr.epochs[j].k);
      }
      var vk = await deriveVaultKeys(null, kr.nk);
      if (b64u(vk.cNk) !== head.body.commit.nk) throw new IntegrityError('name key fails the roster commitment', { code: 'keyring_mismatch' });
      // commit to the session
      s.vaultId = vaultId; s.slotId = slotRes.slot; s.sv = slotRes.sv; s.wrappedStr = slotRes.wrapped;
      s.keySets = keySets; s.activeIdx = idx; s.ePriv = ePriv; s.sPriv = sPriv;
      if (!s.keys || !bytesEqual(s.nk, kr.nk)) {
        s.nk = kr.nk;
        // Only non-extractable CryptoKeys are kept for these three (NK, the VMKs and the private scalars stay raw: key building and re-wrapping need them).
        s.keys = { kIdKey: await hmacKey(vk.kId), kCommit: await hmacKey(vk.kCommit), kState: await hmacKey(vk.kState) };
      }
      if (!s.stateLoaded) await this._loadState(chain);
      this._checkPin(chain);
      s.chain = chain; s.head = head; s.epoch = head.body.epoch; s.role = entry.role; s.kind = entry.kind;
      s.vmk = vmk; s.encKeys = new Map();
      s.serverSlots = rr.slots || {}; s.recovery = slotRes.recovery || null; s.renewalPending = !!slotRes.renewal_pending;
      s.escrowRetired = this.escrowPins.indexOf(head.escrowId) < 0; // the head still names a retired escrow set: an owner replaces it (_migrateEscrow)
      s.rekeyPending = entry.role === 'owner' && head.body.commit.epochs.length > 1;
      s.recoveredSlots = [];
      for (var c = 1; c < chain.length; c++) {
        if (!chain[c].signedByEscrow) continue;
        for (var q = 0; q < chain[c].body.slots.length; q++) {
          var cand = chain[c].body.slots[q];
          if (!findSlot(chain[c - 1].body, cand.id) && findSlot(head.body, cand.id)) s.recoveredSlots.push(cand.id);
        }
      }
      if (head.body.version > s.pin.rv || (head.body.epoch > s.pin.epoch)) {
        s.pin = { rv: head.body.version, head: head.hash, epoch: Math.max(head.body.epoch, s.pin.epoch) };
        await this._persist();
      }
      return;
    }
    throw new WDSError('roster kept changing while loading; try again');
  };
  CP._stateKeyName = function () { return 'wds:' + this.scope + ':' + this.s.accessId + ':state'; };
  CP._loadState = async function () {
    var s = this.s, raw = this.storage.getItem(this._stateKeyName());
    s.stateLoaded = true;
    if (raw === null || raw === undefined) { s.stateStatus = 'new'; return; }
    var st = await openState(s.keys.kState, raw);
    if (!st || !isInt(st.rv) || !isInt(st.epoch) || typeof st.head !== 'string' || !Array.isArray(st.records)) { s.stateStatus = 'invalid'; return; }
    if (st.scope !== this.scope || st.vault !== s.vaultId || st.access !== s.accessId || st.slot !== s.slotId) { s.stateStatus = 'invalid'; return; }
    s.stateStatus = 'ok';
    s.pin = { rv: st.rv, head: st.head, epoch: st.epoch };
    st.records.forEach(function (r) { if (Array.isArray(r) && typeof r[0] === 'string' && isInt(r[1])) s.seen.set(r[0], r[1]); });
  };
  CP._checkPin = function (chain) {
    var s = this.s, pin = s.pin;
    if (!pin.rv) return;
    if (chain.length < pin.rv) throw new IntegrityError('the server presented an older roster than this device has seen', { code: 'rollback' });
    if (chain[pin.rv - 1].hash !== pin.head) throw new IntegrityError('the roster differs from the one this device has seen', { code: 'rollback' });
    if (last(chain).body.epoch < pin.epoch) throw new IntegrityError('epoch rolled back', { code: 'rollback' });
  };
  CP._persist = function () {
    var self = this, s = this.s;
    if (!s || !s.keys) return Promise.resolve();
    s.persistChain = s.persistChain.then(async function () {
      var recs = Array.from(s.seen.entries()).sort(function (a, b) { return a[0] < b[0] ? -1 : 1; });
      var state = { access: s.accessId, epoch: s.pin.epoch, head: s.pin.head, records: recs, rv: s.pin.rv, scope: self.scope, slot: s.slotId, vault: s.vaultId };
      try { self.storage.setItem(self._stateKeyName(), await sealState(s.keys.kState, state)); } catch (e) { /* storage full or denied */ }
    });
    return s.persistChain;
  };
  CP._see = function (rid, version) {
    var s = this.s;
    if (version > (s.seen.get(rid) || 0)) s.seen.set(rid, version);
  };
  CP._checkSeen = function (rid, version) {
    var prev = this.s.seen.get(rid) || 0;
    if (version < prev) throw new IntegrityError('record version rolled back by the server', { code: 'rollback' });
  };

  CP.status = function () {
    var s = this.s;
    if (!s || !s.head) return { unlocked: false };   // the session exists while the unlock is still running (its roster head is not there yet): not unlocked
    return {
      unlocked: true, scope: this.scope, accessId: s.accessId, vaultId: s.vaultId, slotId: s.slotId, role: s.role, kind: s.kind,
      epoch: s.epoch, rosterVersion: s.head.body.version, rekeyPending: s.rekeyPending,
      recoveredByFaculty: s.chain.some(function (c) { return c.signedByEscrow; }), escrowRetired: !!s.escrowRetired,
      recoverySlots: s.recoveredSlots.slice(), stateStatus: s.stateStatus, newDevice: s.stateStatus !== 'ok',
      recovery: s.recovery, warnings: s.warnings.slice(), renewalPending: s.renewalPending,
    };
  };
  CP._need = function (role) {
    var s = this.s;
    if (!s) throw new UsageError('locked: unlock the vault first', { code: 'locked' });
    if (role === 'owner' && s.role !== 'owner') throw new AuthError('this action needs an owner slot', { code: 'forbidden' });
    if (role === 'write' && s.role === 'read') throw new AuthError('this slot is read-only', { code: 'forbidden' });
  };

  // ---- records ----
  CP._rid = async function (name) { checkRecordName(name); return b64u(await hmacSign(this.s.keys.kIdKey, utf8(name))); };
  CP._encKey = async function (epoch) {
    var s = this.s, k = s.encKeys.get(epoch);
    if (k) return k;
    var vmk = s.vmk.get(epoch);
    if (!vmk) return null;
    k = await aesKey(await hkdf(vmk, EMPTY, 'wds1/record-enc'));
    s.encKeys.set(epoch, k);
    return k;
  };
  CP._fetchRecord = async function (rid, version) {
    var s = this.s;
    var path = '/vaults/' + s.vaultId + '/records/' + rid + (version ? '/versions/' + version : '');
    var res;
    try { res = await this._req('GET', path, { auth: this._auth() }); }
    catch (e) {
      if (e.status === 404 && e.code === 'deleted' && e.body && isInt(e.body.version)) return { deleted: true, version: e.body.version };
      if (e.status === 404) return null;
      throw e;
    }
    var m = /^"(\d+)"$/.exec(res.headers.get('ETag') || '');
    var commit = res.headers.get('WDS-Commit');
    if (!m || !commit) throw new IntegrityError('record response lacks ETag or commitment');
    var v = Number(m[1]);
    if (version && v !== version) throw new IntegrityError('server returned a different version than requested');
    return { version: v, commit: commit, bytes: new Uint8Array(await this._within(res.arrayBuffer(), Number(res.headers.get('Content-Length')) || 0)) };
  };
  CP._openFetched = async function (rid, name, f) {
    var s = this.s;
    var env = parseEnvelope(f.bytes, T_RECORD);
    var key = await this._encKey(env.epoch);
    if (!key) { await this._syncHead(); key = await this._encKey(env.epoch); }
    if (!key) throw new IntegrityError('no key for epoch ' + env.epoch + ' in the keyring', { code: 'missing_epoch' });
    var pt = await openEnvelope(key, env, aadRecord(this.scope, s.vaultId, rid, f.version));
    if (f.commit !== await commitment(s.keys.kCommit, rid, f.version, pt)) throw new IntegrityError('history commitment does not match', { code: 'commit_mismatch' });
    var rec = parseRecordPlaintext(pt, name);
    if (name === undefined && (await this._rid(rec.name)) !== rid) throw new IntegrityError('record name does not match its ID');
    rec.version = f.version; rec.epoch = env.epoch; rec.length = rec.body.length;
    return rec;
  };
  function publicRecord(r) {
    return { name: r.name, version: r.version, kind: r.kind, mime: r.mime, time: r.time, length: r.length, epoch: r.epoch, value: r.value };
  }
  // What the name cache keeps: metadata only (bodies of attachments must not pile up in memory).
  function recordMeta(r) {
    return { name: r.name, version: r.version, kind: r.kind, mime: r.mime, time: r.time, length: r.length, epoch: r.epoch };
  }
  // A record that list() downloaded is kept for a short time, so that the get() that follows a list() does not download it a second
  // time. The entry is used once, only for the version that list() saw, and only while nothing else touched the record.
  var LISTED_TTL_MS = 30000, LISTED_MAX_ONE = 1048576, LISTED_MAX_ALL = 16777216;
  CP._dropListed = function (rid) {
    var s = this.s, h = s.listed.get(rid);
    if (h) { s.listed.delete(rid); s.listedBytes -= h.size; }
  };
  CP._keepListed = function (rid, rec) {
    var s = this.s, size = rec.length;
    this._dropListed(rid);
    if (size > LISTED_MAX_ONE || s.listedBytes + size > LISTED_MAX_ALL) return;
    s.listed.set(rid, { rec: rec, size: size, t: this.now() });
    s.listedBytes += size;
  };
  CP._takeListed = function (rid, name) {
    var s = this.s, h = s.listed.get(rid), k = s.known.get(rid);
    if (!h) return null;
    this._dropListed(rid);
    if (this.now() - h.t > LISTED_TTL_MS || h.rec.name !== name || !k || k.deleted || k.version !== h.rec.version) return null;
    return h.rec;
  };
  // opts.fresh: read from the server even when list() just downloaded the record (the list cache).
  CP.getRecord = async function (name, opts) {
    this._need('read');
    var s = this.s, rid = await this._rid(name);
    if (opts && opts.fresh) this._dropListed(rid);
    var held = this._takeListed(rid, name);
    if (held) {
      this._checkSeen(rid, held.version);
      s.nameCache.set(rid, recordMeta(held));
      this._see(rid, held.version);
      await this._persist();
      return publicRecord(held);
    }
    var f = await this._fetchRecord(rid);
    if (!f) return null;
    this._checkSeen(rid, f.version);
    if (f.deleted) { s.known.set(rid, { version: f.version, deleted: true }); s.nameCache.delete(rid); return null; }
    var rec = await this._openFetched(rid, name, f);
    s.known.set(rid, { version: f.version, deleted: false });
    s.nameCache.set(rid, recordMeta(rec));
    this._see(rid, f.version);
    await this._persist();
    return publicRecord(rec);
  };
  CP.get = async function (name, opts) {
    var r = await this.getRecord(name, opts);
    return r === null ? undefined : r.value;
  };
  async function encodeValue(value, opts) {
    var kind, body, mime = opts && opts.mime;
    if (value === undefined) throw new UsageError('cannot store undefined');
    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) { kind = 'bytes'; body = toBytes(value); }
    else if (typeof Blob !== 'undefined' && value instanceof Blob) {
      kind = 'bytes'; body = new Uint8Array(await value.arrayBuffer());
      if (!mime && value.type) mime = value.type;
    } else {
      var text = JSON.stringify(value);
      if (text === undefined) throw new UsageError('value is not JSON-serialisable');
      kind = 'json'; body = utf8(text);
    }
    return { kind: kind, body: body, mime: kind === 'bytes' ? mime : undefined };
  }
  CP.put = async function (name, value, opts) {
    opts = opts || {};
    if (Object.prototype.hasOwnProperty.call(opts, 'base') && opts.base === undefined) throw new UsageError('put: base is undefined; pass a version number, null (must not exist), or leave it out');
    this._need('write');
    var s = this.s, enc = await encodeValue(value, opts);
    var info = this._scopeInfo;
    if (info && info.limits && isInt(info.limits.max_value_bytes) && enc.body.length > info.limits.max_value_bytes) {
      throw new QuotaError('value larger than the limit of ' + info.limits.max_value_bytes + ' bytes', { code: 'value_too_large', limit: info.limits.max_value_bytes });
    }
    var rid = await this._rid(name);
    for (var attempt = 0; ; attempt++) {
      var k = s.known.get(rid);
      var base = opts.base !== undefined ? opts.base : (k ? k.version : null);
      var version = base === null ? 1 : base + 1;
      var built = buildRecordPlaintext(name, enc.kind, enc.body, enc.mime, this.now());
      var env = await sealRecord({ key: await this._encKey(s.epoch), epoch: s.epoch, scope: this.scope, vault: s.vaultId, rid: rid, version: version, plaintext: built.plaintext });
      var headers = { 'Content-Type': 'application/octet-stream', 'WDS-Commit': await commitment(s.keys.kCommit, rid, version, built.plaintext) };
      if (base === null) headers['If-None-Match'] = '*'; else headers['If-Match'] = '"' + base + '"';
      var res, r = null;
      try { res = await this._req('PUT', '/vaults/' + s.vaultId + '/records/' + rid, { auth: this._auth(), headers: headers, body: env }); }
      catch (e) {
        if (e.status === 409 && e.code === 'epoch_changed' && attempt === 0) { await this._syncHead(); continue; }
        if (e.status === 412) throw await this._conflict(name, rid, { value: value, kind: enc.kind, mime: enc.mime }, e);
        // No answer (a timeout, a lost connection): the server may have stored the write all the same. Look at the record before reporting a failure.
        if (e instanceof OfflineError && await this._landed(rid, version, headers['WDS-Commit'])) r = { version: version, size: env.length };
        else throw e;
      }
      if (!r) {
        try { r = await this._within(res.json()); } catch (e2) { if (e2 instanceof OfflineError) throw e2; throw new IntegrityError('server sent invalid JSON'); }
      }
      if (r.version !== version) throw new IntegrityError('server stored a different version than requested');
      this._dropListed(rid);
      s.known.set(rid, { version: version, deleted: false });
      s.nameCache.set(rid, { name: name, kind: enc.kind, mime: enc.mime === undefined ? null : enc.mime, time: this.now(), length: enc.body.length, version: version, epoch: s.epoch });
      this._see(rid, version);
      await this._persist();
      return { name: name, version: version, size: r.size, epoch: s.epoch };
    }
  };
  // True when the server holds the record at exactly this version with this commitment: our own write, whose answer was lost.
  // A short look (10 s); any failure counts as "not known to have landed", so the caller reports the original error.
  CP._landed = async function (rid, version, commit) {
    try {
      var res = await this._req('GET', '/vaults/' + this.s.vaultId + '/records/' + rid, { auth: this._auth(), timeout: 10000 });
      var m = /^"(\d+)"$/.exec(res.headers.get('ETag') || '');
      return !!m && Number(m[1]) === version && res.headers.get('WDS-Commit') === commit;
    } catch (e) { return false; }
  };
  CP._conflict = async function (name, rid, mine, err) {
    var s = this.s, theirs = null, f = await this._fetchRecord(rid);
    if (f && f.deleted) { theirs = { version: f.version, deleted: true }; s.known.set(rid, { version: f.version, deleted: true }); }
    else if (f) {
      this._checkSeen(rid, f.version);
      var rec = await this._openFetched(rid, name, f);
      theirs = { version: f.version, deleted: false, kind: rec.kind, mime: rec.mime, time: rec.time, value: rec.value };
      s.known.set(rid, { version: f.version, deleted: false });
      s.nameCache.set(rid, recordMeta(rec));
      this._see(rid, f.version);
    }
    return new ConflictError('Another device or person changed "' + name + '" in the meantime', {
      status: 412, code: 'precondition_failed', record: name, rid: rid, mine: mine, theirs: theirs, current: theirs ? theirs.version : null, body: err.body,
    });
  };
  CP.delete = async function (name, opts) {
    opts = opts || {};
    this._need('write');
    var s = this.s, rid = await this._rid(name), base = opts.base;
    if (base === undefined) {
      var k = s.known.get(rid);
      if (k && k.deleted) return false;
      if (k) base = k.version;
      else {
        var f = await this._fetchRecord(rid);
        if (!f || f.deleted) return false;
        base = f.version;
      }
    }
    var res;
    try { res = await this._req('DELETE', '/vaults/' + s.vaultId + '/records/' + rid, { auth: this._auth(), headers: { 'If-Match': '"' + base + '"' } }); }
    catch (e) {
      if (e.status === 412) throw await this._conflict(name, rid, { deleted: true }, e);
      throw e;
    }
    var r = await this._within(res.json());
    if (r.version !== base + 1) throw new IntegrityError('server stored a different version than requested');
    this._dropListed(rid);
    s.known.set(rid, { version: r.version, deleted: true });
    s.nameCache.delete(rid);
    this._see(rid, r.version);
    await this._persist();
    return true;
  };
  CP.remove = CP.delete;

  // Lists live records: [{name, version, kind, mime, length, time, epoch}] filtered by name prefix, sorted by name.
  // Names are only known inside the encrypted records, so every new or changed record is downloaded once per session.
  CP.list = async function (prefix) {
    this._need('read');
    var s = this.s, entries = [], after = null;
    do {
      var r = await this._json('GET', '/vaults/' + s.vaultId + '/records?limit=1000' + (after ? '&after=' + encodeURIComponent(after) : ''), { auth: this._auth() });
      if (!r || !Array.isArray(r.records)) throw new IntegrityError('bad record list');
      entries = entries.concat(r.records);
      after = r.next || null;
    } while (after);
    var self = this, live = [], now = this.now();
    s.listed.forEach(function (h, rid) { if (now - h.t > LISTED_TTL_MS) self._dropListed(rid); });
    entries.forEach(function (e) {
      self._checkSeen(e.id, e.version);
      if (e.deleted) { s.nameCache.delete(e.id); s.known.set(e.id, { version: e.version, deleted: true }); } else live.push(e);
    });
    var out = await pool(live, 4, async function (e) {
      var c = s.nameCache.get(e.id);
      if (!c || c.version !== e.version) {
        var f = await self._fetchRecord(e.id);
        if (!f || f.deleted) return null;
        self._checkSeen(e.id, f.version);
        var full = await self._openFetched(e.id, undefined, f);
        c = recordMeta(full);
        s.nameCache.set(e.id, c);
        self._keepListed(e.id, full);
      }
      s.known.set(e.id, { version: c.version, deleted: false });
      self._see(e.id, c.version);
      return publicRecord(c);
    });
    await this._persist();
    prefix = prefix || '';
    return out.filter(function (r) { return r !== null && r.name.startsWith(prefix); }).map(function (r) { delete r.value; return r; })
      .sort(function (a, b) { return a.name < b.name ? -1 : a.name > b.name ? 1 : 0; });
  };
  CP.readAll = async function (prefix) {
    var names = await this.list(prefix), out = [];
    for (var i = 0; i < names.length; i++) { var r = await this.getRecord(names[i].name); if (r) out.push(r); }
    return out;
  };

  CP.history = async function (name) {
    this._need('read');
    var s = this.s, rid = await this._rid(name);
    var h = await this._json('GET', '/vaults/' + s.vaultId + '/records/' + rid + '/versions', { auth: this._auth() });
    if (!h || !Array.isArray(h.versions) || h.id !== rid) throw new IntegrityError('bad history response');
    return { name: name, current: h.current, versions: h.versions.map(function (v) {
      return { version: v.version, epoch: v.epoch, size: v.size, created: v.created, deleted: !!v.deleted, commit: v.commit || null };
    }) };
  };
  CP.getVersion = async function (name, version) {
    this._need('read');
    var rid = await this._rid(name), f = await this._fetchRecord(rid, version);
    if (!f) return null;
    if (f.deleted) return { name: name, version: f.version, deleted: true };
    return publicRecord(await this._openFetched(rid, name, f));
  };
  CP.restore = async function (name, version) {
    this._need('write');
    var old = await this.getVersion(name, version);
    if (!old || old.deleted) throw new UsageError('that version does not hold a value', { code: 'not_restorable' });
    var h = await this.history(name);
    var value = old.kind === 'bytes' ? old.value : old.value;
    return this.put(name, value, { base: h.current, mime: old.mime === null ? undefined : old.mime });
  };
  CP.deleteHistory = async function (name) {
    this._need('owner');
    var rid = await this._rid(name);
    return this._json('DELETE', '/vaults/' + this.s.vaultId + '/records/' + rid + '/versions', { auth: this._auth() });
  };
  // Records this session has read or written whose version on the server is newer than the known one (cheap: only the
  // record list, nothing is downloaded). Returns [{name|null, version, known, deleted}].
  // opts.names: record names that count as known at version 0 when this session has not seen them yet (a collection index that did not exist
  // when it was loaded), so that their first appearance is reported too.
  CP.checkRemote = async function (opts) {
    this._need('read');
    var s = this.s, after = null, out = [], watch = new Map();
    var names = (opts && opts.names) || [];
    for (var wi = 0; wi < names.length; wi++) watch.set(await this._rid(names[wi]), names[wi]);
    do {
      var r = await this._json('GET', '/vaults/' + s.vaultId + '/records?limit=1000' + (after ? '&after=' + encodeURIComponent(after) : ''), { auth: this._auth() });
      if (!r || !Array.isArray(r.records)) throw new IntegrityError('bad record list');
      for (var i = 0; i < r.records.length; i++) {
        var e = r.records[i], k = s.known.get(e.id);
        if (!k && watch.has(e.id) && !e.deleted) out.push({ name: watch.get(e.id), version: e.version, known: 0, deleted: false });
        else if (k && e.version > k.version) {
          var c = s.nameCache.get(e.id);
          out.push({ name: c ? c.name : null, version: e.version, known: k.version, deleted: !!e.deleted });
        }
      }
      after = r.next || null;
    } while (after);
    return out;
  };
  // Owner: cancel a pending faculty recovery request (DELETE /vaults/{v}/recovery).
  CP.cancelRecovery = async function () {
    this._need('owner');
    var r = await this._json('DELETE', '/vaults/' + this.s.vaultId + '/recovery', { auth: this._auth() });
    if (this.s) this.s.recovery = null;
    return r;
  };
  CP.usage = async function () { this._need('read'); return this._json('GET', '/vaults/' + this.s.vaultId + '/usage', { auth: this._auth() }); };
  CP.deleteVault = async function () {
    this._need('owner');
    var r = await this._json('DELETE', '/vaults/' + this.s.vaultId, { auth: this._auth() });
    this.s = null;
    return r;
  };

  // ---- roster editing (owner) ----
  // change(body, ctx): mutates the draft (next version, prev/hash/signer/time already set). ctx: {vmk: Map, nk, newSlots: [], session}.
  CP._commitRoster = async function (change) {
    this._need('owner');
    var s = this.s;
    for (var attempt = 0; attempt < 4; attempt++) {
      await this._syncHead();
      var head = s.head;
      if (s.recoveredSlots.some(function (id) { return id !== s.slotId; }) && !s.recoveryAck) {
        throw new UsageError('this vault was recovered by the faculty; acknowledge the added owner first', { code: 'recovery_unacknowledged' });
      }
      var body = cloneJson(head.body);
      body.version = head.body.version + 1; body.prev = head.hash; body.time = Math.floor(this.now() / 1000); body.signer = s.slotId;
      var ctx = { vmk: new Map(s.vmk), nk: s.nk, newSlots: [], session: s };
      await change(body, ctx);
      // Keyring entries are encrypted to the escrow slot: never to a retired (possibly leaked) key.
      if (this.escrowPins.indexOf(await bodyEscrowId(body)) < 0) throw new UsageError('the escrow keys of this vault are retired; they are replaced first', { code: 'escrow_retired' });
      body.slots.sort(function (a, b) { return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; });
      body.commit.epochs.sort(function (a, b) { return a.e - b.e; });
      var keyring = await makeKeyring(this.scope, body, ctx.vmk, ctx.nk);
      var roster = await signRoster(body, s.sPriv);
      var req = { roster: roster, keyring: keyring };
      if (ctx.newSlots.length) req.new_slots = ctx.newSlots;
      var res;
      try { res = await this._json('POST', '/vaults/' + s.vaultId + '/roster', { auth: this._auth(), json: req }); }
      catch (e) { if (e.status === 409 && e.code === 'roster_conflict') continue; throw e; }
      await this._syncHead();
      return res;
    }
    throw new WDSError('the roster changed concurrently too often; try again');
  };
  CP.acknowledgeRecovery = function () { this._need('owner'); this.s.recoveryAck = true; };

  // Members as the owner sees them: roster entry plus the server's view of each slot.
  CP.members = function () {
    var s = this.s, me = this;
    if (!s) throw new UsageError('locked', { code: 'locked' });
    return s.head.body.slots.map(function (sl) {
      var st = s.serverSlots[sl.id] || {};
      return {
        slotId: sl.id, role: sl.role, kind: sl.kind, expires: sl.expires, self: sl.id === s.slotId, escrow: sl.kind === 'escrow',
        revocable: s.role === 'owner' && me._mayRevoke(sl),
        used: !!st.used, redeemed: st.redeemed || null, expired: !!st.expired, renewalPending: !!st.renewal,
        addedByEscrow: s.recoveredSlots.indexOf(sl.id) >= 0,
      };
    });
  };

  CP.createInvite = async function (o) { // {role: 'write'|'read', expiresIn: seconds}
    o = o || {};
    this._need('owner');
    var role = o.role || 'write';
    if (role !== 'write' && role !== 'read') throw new UsageError('invites are for write or read access');
    var expiresIn = o.expiresIn === undefined ? 172800 : o.expiresIn;
    if (!Number.isInteger(expiresIn) || expiresIn < 3600 || expiresIn > 14 * 86400) throw new UsageError('invite expiry must be between 1 hour and 14 days');
    for (var attempt = 0; ; attempt++) {
      var s = this.s;
      var e = await generateKeyPair('E'), sg = await generateKeyPair('S');
      var secret = randomBytes(17), idBytes = randomBytes(12), accessId = await b32cEncode(idBytes), slotId = randomSlotId();
      var sk = await deriveSlotKeys(secret), kdf = { alg: 'invite' };
      var wrapped = await wrapSlot({ kWrapRaw: sk.kWrap, scope: this.scope, vault: s.vaultId, accessId: accessId, kdf: kdf, slotId: slotId, keySets: [{ e: e, s: sg }] });
      var expires = Math.floor(this.now() / 1000) + expiresIn;
      try {
        await this._commitRoster(function (body, ctx) {
          body.slots.push({ e_pub: b64u(e.pub), expires: expires, id: slotId, kind: 'invite', role: role, s_pub: b64u(sg.pub) });
          ctx.newSlots.push({ slot: slotId, access_id: accessId, kdf: kdf, token_hash: b64u(sk.tokenHash), wrapped: b64u(wrapped) });
        });
      } catch (err) {
        if (err && err.status === 409 && (err.code === 'slot_id_taken' || err.code === 'access_id_taken') && attempt < 3) continue;
        throw err;
      }
      var code = await makeInviteCode(idBytes, secret);
      return { code: code, accessId: accessId, slotId: slotId, role: role, expires: expires };
    }
  };

  // Redeem an invite code: choose a passphrase, re-wrap the slot keys, announce fresh keys. Leaves the vault unlocked.
  CP.redeemInvite = async function (o) { // {inviteCode, passphrase}
    var p = await parseInviteCode(o.inviteCode);
    var k = await this._json('GET', '/slots/' + p.accessId + '/kdf');
    if (k.kind !== 'invite') throw new RequestError('this invite was already redeemed', { status: 409, code: 'already_redeemed' });
    var inv = await deriveSlotKeys(p.secret), auth = { accessId: p.accessId, token: inv.token }, kdfInv = { alg: 'invite' };
    var slotRes = await this._json('GET', '/slots/' + p.accessId, { auth: auth });
    if (slotRes.access_id !== p.accessId || slotRes.scope !== this.scope || !RE_VAULT.test(slotRes.vault || '')) throw new IntegrityError('slot response does not match the request');
    var blob = await unwrapSlot({ kWrapRaw: inv.kWrap, scope: this.scope, vault: slotRes.vault, accessId: p.accessId, kdf: kdfInv, envelope: b64uDecode(slotRes.wrapped) });
    if (blob.vault !== slotRes.vault || blob.slot !== slotRes.slot || blob.keySets.length !== 1) throw new IntegrityError('invite blob does not match the slot');
    var rr = await this._json('GET', '/vaults/' + slotRes.vault + '/roster', { auth: auth });
    var chain = await verifyRosterChain({ scope: this.scope, vault: slotRes.vault, escrowPins: this.escrowPins, retiredEscrow: this.retiredEscrow, docs: rr.versions || [], prior: null });
    var head = last(chain);
    if (!head || head.body.version !== rr.head || head.hash !== rr.head_hash) throw new IntegrityError('roster head does not match the verified chain');
    var entry = findSlot(head.body, slotRes.slot), old = blob.keySets[0];
    if (!entry || entry.kind !== 'invite' || entry.e_pub !== b64u(old.e.pub) || entry.s_pub !== b64u(old.s.pub)) throw new IntegrityError('invite keys do not match the signed roster', { code: 'keys_mismatch' });
    var eN = await generateKeyPair('E'), sN = await generateKeyPair('S');
    var rbody = { e_pub: b64u(eN.pub), rv: head.body.version, s_pub: b64u(sN.pub), scope: this.scope, slot: slotRes.slot, type: 'renewal', v: 1, vault: slotRes.vault };
    var renewal = await signRoster(rbody, await importPrivate('S', old.s.d, old.s.pub)); // same {body, sig} shape
    var kdf = await this._freshKdf();
    var kek = await argon2idKey(o.passphrase, kdf, this.argon2);
    var sk = await deriveSlotKeys(kek);
    var wrapped = await wrapSlot({ kWrapRaw: sk.kWrap, scope: this.scope, vault: slotRes.vault, accessId: p.accessId, kdf: kdf, slotId: slotRes.slot, keySets: [old, { e: eN, s: sN }] });
    await this._json('POST', '/slots/' + p.accessId + '/redeem', { auth: auth, json: { kdf: kdf, token_hash: b64u(sk.tokenHash), wrapped: b64u(wrapped), renewal: renewal }, timeout: this._patientMs() });
    await this._openSession({ accessId: p.accessId, ikm: kek, kdf: kdf, expectedVault: slotRes.vault, maintain: o.maintain });
    this.rememberAccessId(p.accessId);
    return this.status();
  };

  CP._rewrap = async function (keySets) {
    var s = this.s;
    var wrapped = await wrapSlot({ kWrap: s.kWrap, scope: this.scope, vault: s.vaultId, accessId: s.accessId, kdf: s.kdf, slotId: s.slotId, keySets: keySets });
    var res;
    try { res = await this._json('PUT', '/slots/' + s.accessId, { auth: this._auth(), headers: { 'If-Match': '"' + s.sv + '"' }, json: { kdf: s.kdf, token_hash: b64u(s.tokenHash), wrapped: b64u(wrapped) } }); }
    catch (e) { if (e.status === 412) return false; throw e; }
    s.sv = res.sv; s.wrappedStr = b64u(wrapped); s.keySets = keySets; s.activeIdx = 0;
    return true;
  };
  // Light maintenance after unlock: drop superseded key sets, adopt pending renewals (owner).
  CP._maintain = async function () {
    var s = this.s;
    try {
      if (s.keySets.length === 2 && s.activeIdx === 1) await this._rewrap([s.keySets[1]]);
      if (s.role === 'owner' && s.escrowRetired) await this._migrateEscrow();
      if (s.role === 'owner') await this.adoptRenewals();
      if (s.role === 'owner') await this._dropExpiredInvites();
    } catch (e) {
      if (e instanceof OfflineError || e instanceof RequestError || e instanceof ConflictError) s.warnings.push('maintenance failed: ' + e.message);
      else if (e instanceof UsageError && e.code === 'recovery_unacknowledged') s.warnings.push('maintenance skipped until the recovery notice is acknowledged');
      else if (e instanceof IntegrityError && e.code === 'escrow_not_pinned') s.warnings.push('escrow migration skipped: ' + e.message);
      else throw e;
    }
  };
  // Owner: the head roster names an escrow key set that this library has retired. Switch the escrow slot to the
  // current pinned set the server offers (owner-signed; PROTOCOL 6.3 (c)); the keyring entry for the escrow slot is
  // re-encrypted to the new key by the normal keyring rule (6.4). Returns true when a roster version was written.
  CP._migrateEscrow = async function () {
    this._need('owner');
    var esc = await this._pickEscrow(await this.getScopeInfo(true));
    await this._syncHead();
    if (!this.s.escrowRetired) return false;
    await this._commitRoster(function (body) {
      var sl = bodyEscrow(body);
      sl.e_pub = esc.e_pub; sl.s_pub = esc.s_pub;
    });
    return true;
  };
  CP.maintain = async function () { this._need('read'); await this._syncHead(); await this._maintain(); return this.status(); };

  async function verifyRenewal(doc, entry, head, scope) {
    try {
      var b = doc && doc.body;
      if (!b || Object.keys(b).sort().join(',') !== 'e_pub,rv,s_pub,scope,slot,type,v,vault') return false;
      if (b.type !== 'renewal' || b.v !== 1 || b.scope !== scope || b.vault !== head.vault || b.slot !== entry.id) return false;
      if (!isInt(b.rv) || b.rv > head.version) return false;
      checkPub(b64uDecode(b.e_pub, 65)); checkPub(b64uDecode(b.s_pub, 65));
      return await ecdsaVerify(b64uDecode(entry.s_pub, 65), b64uDecode(doc.sig, 64), cjsonBytes(b));
    } catch (e) { return false; }
  }
  // Owner: sign pending key renewals of members (and of this slot) into a new roster version.
  CP.adoptRenewals = async function () {
    this._need('owner');
    var s = this.s, head = s.head.body, todo = [], ids = Object.keys(s.serverSlots || {});
    for (var i = 0; i < ids.length; i++) {
      var st = s.serverSlots[ids[i]], entry = findSlot(head, ids[i]);
      if (!st || !st.renewal || !entry || entry.kind === 'escrow') continue;
      // An owner slot adopts its own renewal only (PROTOCOL 6.3): another owner's keys are never signed in by someone else.
      if (entry.role === 'owner' && ids[i] !== s.slotId) continue;
      if (!(await verifyRenewal(st.renewal, entry, head, this.scope))) { s.warnings.push('ignored an invalid key renewal'); continue; }
      var b = st.renewal.body;
      if (b.e_pub === entry.e_pub && b.s_pub === entry.s_pub) continue;
      todo.push({ id: ids[i], e_pub: b.e_pub, s_pub: b.s_pub, redeemed: st.redeemed });
    }
    if (!todo.length) return { adopted: 0 };
    await this._commitRoster(function (body) {
      todo.forEach(function (t) {
        var sl = findSlot(body, t.id);
        if (!sl) return;
        sl.e_pub = t.e_pub; sl.s_pub = t.s_pub;
        if (sl.kind === 'invite' && t.redeemed) { sl.kind = 'passphrase'; sl.expires = null; }
      });
    });
    return { adopted: todo.length };
  };
  CP.changePassphrase = async function (newPassphrase) {
    this._need('read');
    var s = this.s, kdf = await this._freshKdf();
    var kek = await argon2idKey(newPassphrase, kdf, this.argon2), sk = await deriveSlotKeys(kek);
    var wrapped = await wrapSlot({ kWrapRaw: sk.kWrap, scope: this.scope, vault: s.vaultId, accessId: s.accessId, kdf: kdf, slotId: s.slotId, keySets: s.keySets });
    var r = await this._json('PUT', '/slots/' + s.accessId, { auth: this._auth(), headers: { 'If-Match': '"' + s.sv + '"' }, json: { kdf: kdf, token_hash: b64u(sk.tokenHash), wrapped: b64u(wrapped) } });
    s.token = sk.token; s.tokenHash = sk.tokenHash; s.kWrap = await aesKey(sk.kWrap); s.kdf = kdf; s.sv = r.sv; s.wrappedStr = b64u(wrapped);
    return { sv: r.sv };
  };

  // ---- members: revoke, cancel, roles ----
  CP.revoke = async function (slotIds, o) {
    o = o || {};
    this._need('owner');
    var ids = Array.isArray(slotIds) ? slotIds.slice() : [slotIds], s = this.s, self = this;
    if (!ids.length) throw new UsageError('nothing to revoke');
    ids.forEach(function (id) {
      var sl = findSlot(s.head.body, id);
      if (!sl) throw new UsageError('unknown slot', { code: 'unknown_slot' });
      if (sl.kind === 'escrow') throw new UsageError('the escrow slot cannot be revoked', { code: 'forbidden_target' });
      if (id === s.slotId) throw new UsageError('an owner cannot revoke its own slot', { code: 'forbidden_target' });
      if (!self._mayRevoke(sl)) throw new UsageError('this owner slot cannot be revoked by this owner (PLAN 5.7)', { code: 'forbidden_target' });
    });
    await this._commitRoster(async function (body, ctx) {
      body.slots = body.slots.filter(function (x) { return ids.indexOf(x.id) < 0; });
      var e = body.epoch + 1, vmk = randomBytes(32), dk = await deriveVaultKeys(vmk, null);
      ctx.vmk.set(e, vmk);
      body.epoch = e;
      body.commit.epochs.push({ c: b64u(dk.cVmk), e: e });
    });
    if (o.rekey === false) return { done: false, rekeyed: 0 };
    return this.resumeRekey(o);
  };
  // PLAN 5.7: members (write, read) can always be revoked by an owner. Owner slots only like this: an owner may revoke an
  // owner slot that escrow added (recovery), and an escrow-added owner may revoke any other owner slot (so a user who
  // recovers after losing a device can cut off the old credential). The two original-style owners never evict each other.
  CP._mayRevoke = function (sl) {
    var s = this.s;
    if (!sl || sl.kind === 'escrow' || sl.id === s.slotId) return false;
    if (sl.role !== 'owner') return true;
    return s.recoveredSlots.indexOf(sl.id) >= 0 || s.recoveredSlots.indexOf(s.slotId) >= 0;
  };
  // Withdraw an invite. An invite that was never used is simply removed from the roster. Any request with the invite
  // token marks it as used on the server (the first request of a redemption, an aborted redemption, or someone who
  // intercepted the code), and that very response contains the keyring entry with the vault keys. Such an invite can
  // only be withdrawn like a member: by a revocation (new epoch and re-encryption, see revoke()), which is what this
  // method does when the server reports the invite as used or answers 409 revocation_required. With
  // {revoke: false} it throws that RequestError instead (the UI asks for a confirmation first). Other options are
  // those of revoke(). Returns {revoked: bool} (plus {done, rekeyed} after a revocation).
  CP.cancelInvite = async function (slotId, o) {
    o = o || {};
    this._need('owner');
    await this._syncHead(); // fresh server view of used/redeemed
    var s = this.s, sl = findSlot(s.head.body, slotId);
    if (!sl || sl.kind !== 'invite') throw new UsageError('not an invite', { code: 'unknown_slot' });
    var used = !!(s.serverSlots[slotId] && s.serverSlots[slotId].used);
    if (!used) {
      try {
        await this._commitRoster(function (body) {
          var x = findSlot(body, slotId);
          if (!x || x.kind !== 'invite') throw new UsageError('not an invite', { code: 'unknown_slot' });
          body.slots = body.slots.filter(function (y) { return y.id !== slotId; });
        });
        return { revoked: false };
      } catch (e) {
        if (!(e && e.status === 409 && e.code === 'revocation_required')) throw e;
        // the invite was used between the two requests: fall through to the revocation
      }
    }
    if (o.revoke === false) throw new RequestError('this invite was used; withdrawing it needs a revocation', { status: 409, code: 'revocation_required' });
    var r = await this.revoke([slotId], o);
    return Object.assign({ revoked: true }, r);
  };
  // Owner, after unlock: remove invite slots that expired without being redeemed. The server cannot do this itself:
  // it never signs, and every roster version needs an owner's signature, which clients verify along the whole chain
  // (PROTOCOL 6.3). Until an owner unlocks, an expired invite is already dead: its token answers 410 invite_expired.
  // Invites that were never used are removed in one version without a new epoch. If one of them was used, the
  // cleanup is a revocation (epoch + 1); its re-encryption is left to the resumable rekey (rekeyPending) so that the
  // unlock does not wait for it. Owner invites (added by the faculty) are never removed automatically.
  CP._dropExpiredInvites = async function () {
    var s = this.s, ids = [], used = false;
    s.head.body.slots.forEach(function (sl) {
      var st = s.serverSlots[sl.id];
      if (sl.kind !== 'invite' || sl.role === 'owner' || !st || !st.expired || st.redeemed) return;
      ids.push(sl.id);
      if (st.used) used = true;
    });
    if (!ids.length) return 0;
    if (used) await this.revoke(ids, { rekey: false });
    else {
      await this._commitRoster(function (body) {
        body.slots = body.slots.filter(function (x) { return ids.indexOf(x.id) < 0 || x.kind !== 'invite'; });
      });
    }
    return ids.length;
  };
  CP.setRole = async function (slotId, role) {
    this._need('owner');
    if (role !== 'write' && role !== 'read') throw new UsageError('role must be write or read');
    await this._commitRoster(function (body) {
      var sl = findSlot(body, slotId);
      if (!sl || sl.role === 'owner') throw new UsageError('role of this slot cannot change', { code: 'forbidden_target' });
      sl.role = role;
    });
  };

  // ---- re-encryption after revocation (resumable) ----
  CP._rekeyOne = async function (item, cur) {
    var s = this.s;
    var f = await this._fetchRecord(item.id, item.version);
    if (!f || f.deleted) return false;
    var env = parseEnvelope(f.bytes, T_RECORD);
    if (env.epoch >= cur) return false;
    var oldKey = await this._encKey(env.epoch);
    if (!oldKey) throw new IntegrityError('no key for epoch ' + env.epoch, { code: 'missing_epoch' });
    var pt = await openEnvelope(oldKey, env, aadRecord(this.scope, s.vaultId, item.id, f.version));
    if (f.commit !== await commitment(s.keys.kCommit, item.id, f.version, pt)) throw new IntegrityError('history commitment does not match; refusing to re-encrypt', { code: 'commit_mismatch' });
    var out = await sealRecord({ key: await this._encKey(cur), epoch: cur, scope: this.scope, vault: s.vaultId, rid: item.id, version: f.version, plaintext: pt });
    try {
      await this._req('PUT', '/vaults/' + s.vaultId + '/records/' + item.id + '/versions/' + f.version + '/rekey',
        { auth: this._auth(), headers: { 'Content-Type': 'application/octet-stream', 'If-Match': '"e' + env.epoch + '"' }, body: out });
    } catch (e) {
      if (e.status === 412) return false; // somebody else was faster
      if (e.status === 409 && e.code === 'epoch_changed') return 'epoch_changed';
      throw e;
    }
    return true;
  };
  // o: {maxItems, onProgress({rekeyed, remaining}), dropOld}. Returns {done, rekeyed}.
  CP.resumeRekey = async function (o) {
    o = o || {};
    this._need('owner');
    var s = this.s, rekeyed = 0, passes = 0;
    outer: for (;;) {
      await this._syncHead();
      var cur = s.epoch;
      if (!s.rekeyPending) return { done: true, rekeyed: rekeyed };
      var after = null;
      do {
        var page = await this._json('GET', '/vaults/' + s.vaultId + '/rekey?limit=500' + (after ? '&after=' + encodeURIComponent(after) : ''), { auth: this._auth() });
        if (page.epoch !== cur) continue outer;
        for (var i = 0; i < page.items.length; i++) {
          if (o.maxItems !== undefined && rekeyed >= o.maxItems) return { done: false, rekeyed: rekeyed };
          var r = await this._rekeyOne(page.items[i], cur);
          if (r === 'epoch_changed') continue outer;
          if (r) rekeyed++;
          if (o.onProgress) o.onProgress({ rekeyed: rekeyed, remaining: Math.max(0, page.remaining - i - 1) });
        }
        after = page.next || null;
      } while (after);
      var check = await this._json('GET', '/vaults/' + s.vaultId + '/rekey?limit=1', { auth: this._auth() });
      if (check.items.length === 0) break;
      if (++passes >= 3) throw new WDSError('re-encryption did not converge');
    }
    if (o.dropOld !== false) await this._dropOldEpochs();
    return { done: true, rekeyed: rekeyed };
  };
  // The client's own check that no stored blob uses an old epoch (does not trust the server's count).
  CP._verifyNoOldEpochs = async function () {
    var s = this.s, cur = s.epoch, after = null, ids = [];
    do {
      var r = await this._json('GET', '/vaults/' + s.vaultId + '/records?limit=1000' + (after ? '&after=' + encodeURIComponent(after) : ''), { auth: this._auth() });
      for (var i = 0; i < r.records.length; i++) {
        var e = r.records[i];
        if (e.epoch !== null && e.epoch !== undefined && e.epoch < cur) return false;
        if (e.version > 1) ids.push(e.id);
      }
      after = r.next || null;
    } while (after);
    var self = this, bad = false;
    await pool(ids, 6, async function (id) {
      var h = await self._json('GET', '/vaults/' + s.vaultId + '/records/' + id + '/versions', { auth: self._auth() });
      h.versions.forEach(function (v) { if (v.epoch !== null && v.epoch !== undefined && v.epoch < cur) bad = true; });
    });
    return !bad;
  };
  CP._dropOldEpochs = async function () {
    if (!(await this._verifyNoOldEpochs())) throw new WDSError('blobs with old epochs remain; not dropping old keys', { code: 'old_epoch_blobs' });
    await this._commitRoster(function (body) {
      body.commit.epochs = body.commit.epochs.filter(function (x) { return x.e === body.epoch; });
    });
  };

  // low-level building blocks (tests, test vectors, tools such as wds-recover); not part of the app API and not exported
  // by the production bundle
  var internals = {
    b64u: b64u, b64uDecode: b64uDecode, hex: hex, unhex: unhex, concat: concat, u32: u32, lp: lp, ascii: ascii, utf8: utf8,
    bytesEqual: bytesEqual, b32cEncode: b32cEncode, b32cDecode: b32cDecode, plainCrockford: plainCrockford,
    cjson: cjson, cjsonBytes: cjsonBytes, cjsonParse: cjsonParse, padme: padme,
    sha256: sha256, hkdf: hkdf, hmac: hmac, aesKey: aesKey, aesSeal: aesSeal, aesOpen: aesOpen,
    generateKeyPair: generateKeyPair, importPrivate: importPrivate, importPublic: importPublic, ecdh: ecdh, ecdsaSign: ecdsaSign, ecdsaVerify: ecdsaVerify,
    argon2idKey: argon2idKey, checkKdf: checkKdf, DEFAULT_KDF: DEFAULT_KDF, KDF_WINDOW: KDF_WINDOW,
    envHeader: envHeader, parseEnvelope: parseEnvelope, sealEnvelope: sealEnvelope, openEnvelope: openEnvelope,
    aadRecord: aadRecord, aadSlot: aadSlot, aadKeyring: aadKeyring,
    deriveSlotKeys: deriveSlotKeys, deriveVaultKeys: deriveVaultKeys, recordId: recordId, commitment: commitment, bearerHeader: bearerHeader,
    checkRecordName: checkRecordName, buildRecordPlaintext: buildRecordPlaintext, parseRecordPlaintext: parseRecordPlaintext,
    sealRecord: sealRecord, openRecord: openRecord, slotPlaintext: slotPlaintext, wrapSlot: wrapSlot, unwrapSlot: unwrapSlot,
    eciesSeal: eciesSeal, eciesOpen: eciesOpen, keyringPlaintext: keyringPlaintext, parseKeyringPlaintext: parseKeyringPlaintext,
    makeKeyring: makeKeyring, vaultIdFromPub: vaultIdFromPub, escrowKeyId: escrowKeyId,
    rosterHash: rosterHash, signRoster: signRoster, verifyRosterChain: verifyRosterChain, verifyRenewal: verifyRenewal,
    makeInviteCode: makeInviteCode, makeRecoveryCode: makeRecoveryCode, sealState: sealState, openState: openState,
    randomBytes: randomBytes, randomSlotId: randomSlotId, randomAccessId: randomAccessId,
  };

  var api = {
    version: VERSION, SERVICE_URL: SERVICE_URL, Client: Client,
    errors: { WDSError: WDSError, ConflictError: ConflictError, OfflineError: OfflineError, QuotaError: QuotaError, AuthError: AuthError, IntegrityError: IntegrityError, VersionError: VersionError, RequestError: RequestError, UsageError: UsageError },
    memoryStorage: memoryStorage,
    // codes (usable without a Client)
    parseInviteCode: parseInviteCode, parseRecoveryCode: parseRecoveryCode, classifyCode: classifyCode, normalizeCode: normalizeCode,
    displayCode: displayCode, checkAccessId: checkAccessId,
  };
  if (!PRODUCTION) {
    api.setArgon2 = setArgon2; api.setRandom = setRandom; api.internals = internals;
  } else {
    Object.freeze(api.errors); Object.freeze(api);
  }
  return api;
});
;
/*!
 * wds-ui.js - WIAI Datastore: dialogs and the high-level WDS.connect() API on top of wds-core.js.
 *
 * Loaded after wds-core.js (the build concatenates hash-wasm, wds-core.js and this file into one script). In Node the module exports the pure
 * helpers only (passphrase rules, ZIP writer, texts) for the unit tests. Contract and examples: docs/site/integration.md, docs/site/porting.md.
 *
 * App code uses: const store = WDS.connect({ scope, baseUrl? }); await store.unlock(); store.status() -> { unlocked, role, sandbox };
 * store.get / set / remove; store.collection(prefix, { meta? }) -> { load, items, get, getAll, add, set, remove, autosave };
 * store.autosave(name, getState, { delayMs?, onStatus? }) -> { changed, flush, stop }; store.onChange(fn); store.onConflict(fn);
 * store.showHistory(name); store.openVault(); store.lock() (saves what is pending, then reloads the page); store.migrateLocal({ id, indexedDB, localStorage, map }).
 * Every dialog is a modal <dialog class="wds-root wds-dialog"> with data-wds-view and data-wds on every control; notices are status lines
 * (data-wds-notice); a failed security check and a redeemed invitation are dialogs with OK. The language comes from <html lang> (de* is German, anything else English), without it from navigator.language.
 * Nothing hands the passphrase to app code. Never use innerHTML here: all text goes through textContent.
 */
(function (root, factory) {
  'use strict';
  var Core = root.WDSCore || (typeof require === 'function' ? require('./wds-core.js') : null);
  var api = factory(root, Core);
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else root.WDS = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root, Core) {
  'use strict';

  var UI_VERSION = '1.0.0';
  var Err = Core.errors;
  var INTERNAL_PREFIX = '.wds/';          // record names reserved for the library (member labels)
  var LABELS_RECORD = INTERNAL_PREFIX + 'labels';

  // ------------------------------------------------------------------------------------------------------------
  // 1. Small helpers
  // ------------------------------------------------------------------------------------------------------------
  var uidCounter = 0;
  function uid(p) { uidCounter += 1; return (p || 'wds-id') + '-' + uidCounter; }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  // Let the browser paint before a long synchronous computation (Argon2id).
  function nextPaint() {
    return new Promise(function (resolve) {
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(function () { setTimeout(resolve, 30); });
      else setTimeout(resolve, 30);
    });
  }
  function utf8(s) { return new TextEncoder().encode(s); }
  function hexUpper(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
    return s.toUpperCase();
  }
  function formatBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB';
    return (n / 1048576).toFixed(n < 10485760 ? 1 : 0) + ' MB';
  }
  function fmt(s, params) {
    return String(s).replace(/\{(\w+)\}/g, function (m, k) { return params && params[k] !== undefined ? params[k] : m; });
  }
  function fileSafe(s) {
    var out = String(s).replace(/[\x00-\x1f\x7f<>:"\\|?*]/g, '_').replace(/\/+/g, '/').split('/').map(function (seg) {
      return seg === '' || seg === '.' || seg === '..' ? '_' : seg;
    }).join('/');
    return out.length > 180 ? out.slice(0, 180) : out;
  }

  // DOM builder. Strings become text nodes; "html" is deliberately not supported.
  function el(tag, props, kids) {
    var e = document.createElement(tag);
    if (props) {
      Object.keys(props).forEach(function (k) {
        var v = props[k];
        if (v === undefined || v === null || v === false) return;
        if (k === 'class') e.className = v;
        else if (k === 'text') e.textContent = v;
        else if (k.slice(0, 2) === 'on' && typeof v === 'function') e.addEventListener(k.slice(2), v);
        else if (k === 'value') e.value = v;
        else if (k === 'checked') e.checked = !!v;
        else if (k === 'disabled') e.disabled = !!v;
        else e.setAttribute(k, v === true ? '' : String(v));
      });
    }
    append(e, kids);
    return e;
  }
  function append(parent, kids) {
    if (kids === undefined || kids === null || kids === false) return parent;
    if (Array.isArray(kids)) { kids.forEach(function (k) { append(parent, k); }); return parent; }
    parent.appendChild(typeof kids === 'string' || typeof kids === 'number' ? document.createTextNode(String(kids)) : kids);
    return parent;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  function downloadBlob(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename; a.rel = 'noopener'; a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(url); if (a.parentNode) a.parentNode.removeChild(a); }, 15000);
  }
  function downloadText(text, filename, type) { downloadBlob(new Blob([text], { type: type || 'text/plain;charset=utf-8' }), filename); }

  // ------------------------------------------------------------------------------------------------------------
  // 2. Texts (English and German; German uses the formal "Sie")
  // ------------------------------------------------------------------------------------------------------------
  var TEXT = {
    en: {
      'common.close': 'Close', 'common.cancel': 'Cancel', 'common.continue': 'Continue', 'common.copy': 'Copy', 'common.copied': 'Copied', 'common.retry': 'Try again',
      'err.build': 'This dialog could not be built. Reload the page; if it happens again, tell the developer of this app.',
      'common.loading': 'Connecting to the storage service…', 'common.notifications': 'Notifications', 'common.thisEntry': 'this entry', 'common.back': 'Back',

      'unlock.title': 'Unlock your data', 'unlock.app': 'App: {name}', 'unlock.intro': 'Enter your access ID and your passphrase. Your data is encrypted on this device before it is stored.',
      'unlock.accessId': 'Access ID', 'unlock.accessId.hint': 'Five groups of four characters. You find it on your access sheet.', 'unlock.passphrase': 'Passphrase', 'unlock.submit': 'Unlock',
      'unlock.busy': 'Deriving your key. This takes a moment…', 'unlock.toCreate': 'Create a new vault', 'unlock.toRedeem': 'I have an invite code',
      'unlock.recoveryEntered': 'This looks like an emergency code, not an access ID. The emergency code is only for the faculty recovery procedure.',

      'create.title': 'Create your vault', 'create.intro': 'Your data is encrypted on this device with a key derived from your passphrase. Only you and the people you invite can open it.',
      'create.joinCode': 'Join code', 'create.joinCode.hint': 'You get the join code from the person who runs this app.', 'create.passphrase': 'Passphrase', 'create.repeat': 'Repeat passphrase',
      'create.passphrase.hint': 'At least 12 characters. Four or more unrelated words work well. The server cannot reset a forgotten passphrase.',
      'escrow.title': 'Who can read your data?',
      'escrow.text': 'Data is end-to-end encrypted; the faculty holds a recovery key for emergencies. Whoever holds that key could technically decrypt every vault; the faculty uses it only in a documented procedure with a waiting period of 72 hours.',
      'create.privacy': 'Privacy information', 'create.submit': 'Create vault', 'create.busy': 'Creating your vault. This takes a moment…',
      'create.suspended': 'This app is paused by the faculty. New vaults cannot be created.', 'create.back': 'I already have a vault',

      'pw.show': 'Show passphrase', 'pw.tooShort': 'At least 12 characters are required ({n} so far).',
      'pw.mismatch': 'The two passphrases are different.', 'pw.common': 'This passphrase is on lists of very common passwords. Choose another one.',
      'pw.weak': 'This passphrase is too easy to guess. Use several unrelated words.',
      'pw.weak.noBreachCheck': 'This passphrase is not strong enough: the check against known data breaches is not available, so a stronger passphrase is needed. Use more, longer and unrelated words.',
      'pw.pwned': 'This passphrase appears {count} times in known data breaches. Choose another one.',
      'pw.hibp.unavailable': 'The breach check could not be reached, so this passphrase was not checked against known breaches.', 'pw.hibp.checking': 'Checking against known data breaches…',
      'pw.hibp.note': 'The breach check sends the first five characters of a checksum of your passphrase to the faculty server, which asks Pwned Passwords (USA) on your behalf. The service sees neither your passphrase nor your IP address.',
      'pw.strength': 'Strength: {label}', 'pw.label.0': 'very weak', 'pw.label.1': 'weak', 'pw.label.2': 'fair', 'pw.label.3': 'good', 'pw.label.4': 'strong', 'pw.empty': 'Enter a passphrase.',

      'sheet.title': 'Save your access sheet',
      'sheet.intro.owner': 'You need the access ID and your passphrase to open your data on another device. The emergency code is the only way back if you forget your passphrase.',
      'sheet.intro.member': 'You need the access ID and your passphrase to open the data on another device.',
      'sheet.app': 'App', 'sheet.accessId': 'Access ID', 'sheet.recovery': 'Emergency code', 'sheet.created': 'Created',
      'sheet.service': 'Service', 'sheet.access': 'Access', 'sheet.print': 'Print access sheet', 'sheet.download': 'Download access sheet (HTML)',
      'sheet.passphrase.note': 'Your passphrase is not on this sheet. Remember it, or keep it in a password manager.',
      'sheet.recovery.note': 'Keep the sheet apart from this computer. Whoever holds the emergency code can start a recovery request; you are told about such a request when you unlock and can cancel it during the 72-hour waiting period.',
      'sheet.confirm.owner': 'I have saved the access sheet and the emergency code.', 'sheet.confirm.member': 'I have saved my access ID.',
      'sheet.hibp.skipped': 'Note: the breach check was not available, so your passphrase was not checked against known breaches.',
      'sheet.page.title': 'Access sheet', 'sheet.page.print': 'Print this page',

      'redeem.title': 'Join with an invite code', 'redeem.intro': 'Enter the invite code you received and choose your own passphrase. An invite code works only once.',
      'redeem.code': 'Invite code', 'redeem.code.hint': '48 characters in groups of four.', 'redeem.submit': 'Join',
      'redeem.busy': 'Joining. This takes a moment…', 'redeem.done': 'You now have access', 'redeem.role.write': 'You can read and change the data.',
      'redeem.role.read': 'You can read the data but not change it.', 'redeem.back': 'I already have an access ID',

      'role.owner': 'Owner', 'role.write': 'Can edit', 'role.read': 'Read only',

      'err.notFound': 'This access ID is unknown, or the access was removed.',
      'err.badId': 'This access ID is not valid. Check it for typing errors.', 'err.wrongPass': 'The passphrase does not match this access ID.',
      'err.revoked': 'The owner of the data removed this access.', 'err.expired': 'This invite has expired. Ask the owner for a new one.',
      'err.vaultDeleted': 'This vault was deleted. It is removed for good after 30 days. If that was a mistake, contact the person who runs this app.',
      'err.alreadyRedeemed': 'This invite was already used. Unlock with your access ID and passphrase instead.', 'err.rate': 'Too many attempts. Wait a moment and try again.',
      'err.offline': 'The storage service cannot be reached. Check your internet connection and try again.',
      'err.integrity': 'A security check failed: the data from the server does not match what this device expects ({code}). Do not enter new data and contact the person who runs this app.',
      'err.rollback': 'The server showed older data than this device has seen before. This can be a fault or an attack. Do not continue and contact the person who runs this app.',
      'err.generic': 'Something went wrong: {message}',
      'err.invite.invalid': 'This invite code is not valid. It has 48 characters; check it for typing errors.',
      'err.joinCode': 'The join code is not correct.', 'err.joinCode.missing': 'Enter the join code.',
      'err.vaultLimit': 'This app cannot take new users at the moment. Contact the person who runs it.',
      'err.noPins': 'This build of the storage library is missing the faculty key. Contact the author of the app.',
      'err.accessId.missing': 'Enter your access ID.', 'err.passphrase.missing': 'Enter your passphrase.',
      'err.scope': 'This app is not registered with the storage service.',

      'note.advisory': 'This app uses an outdated version of the storage library. Please ask its author for an update.', 'note.newDevice': 'This device is new to your vault. That is normal.',
      'note.stateInvalid': 'The safety record kept on this device was damaged or changed and has been reset.',
      'note.readOnly': 'The storage service is in read-only mode. Changes cannot be saved at the moment.',
      'note.suspended': 'This app is paused by the faculty. You can read your data but not save changes.',
      'note.redeemed.one': 'An invitation was redeemed.', 'note.redeemed.other': '{n} invitations were redeemed.',
      'note.rekey': 'Re-encrypting stored data after a revocation: {done} done, {left} left.', 'note.rekey.done': 'Re-encryption finished. Revoked access can no longer open any stored data.',
      'note.rekey.failed': 'Re-encryption was interrupted. It continues the next time you unlock.',
      'note.offline': 'Saving failed: the storage service cannot be reached. Your latest changes exist only in this window.',
      'offline.title': 'Not saved',
      'end.ok': 'OK', 'end.revoked.title': 'Your access was removed', 'end.lock.title': 'Not everything is saved',
      'end.lock.text': 'These changes could not be saved yet. Download them as a backup before you lock; the page reloads afterwards.',
      'end.lock.anyway': 'Lock anyway', 'end.reload': 'The page reloads when you continue.',
      'note.backup': 'Download unsaved values (backup)', 'note.backup.none': 'There is nothing to back up yet.',
      'note.quota': 'Saving failed: {message}', 'note.revoked': 'Your access to this vault was removed. The data on this device is locked.',
      'integrity.title': 'A security check failed', 'note.redeemed.title': 'New access',
      'note.forbidden': 'This access is read-only, so the change was not saved.', 'note.exporting': 'Exporting: {done} of {total}',
      'note.exported': 'Export finished: {n} records.', 'note.version': 'This app needs a newer version of the storage library: {message}',

      'conflict.title': 'Another device or person saved a newer version',
      'conflict.intro': 'Another device or person changed {name} after you last loaded it. Choose which version to keep. Nothing is lost: the version you do not keep stays in the history.',
      'conflict.theirs': 'Their version', 'conflict.mine': 'Your version (not saved yet)', 'conflict.saved': 'saved {time}',
      'conflict.theirsDeleted': 'This entry was deleted by someone else.', 'conflict.mineDeleted': 'You wanted to delete this entry.', 'conflict.noTheirs': 'There is no saved version.',
      'conflict.keepTheirs': 'Keep theirs', 'conflict.keepMine': 'Keep mine', 'conflict.file': 'File ({mime}), {size}', 'conflict.truncated': '(shortened)',
      'conflict.delete.title': 'This entry was changed in the meantime',
      'conflict.delete.intro': 'Another device or person changed {name} after you last loaded it, and you wanted to delete it. Delete it anyway, or keep the newer version? A deleted entry stays in the history.',
      'conflict.delete.keepMine': 'Delete anyway', 'conflict.delete.keepTheirs': 'Keep the entry',

      'history.title': 'History of {name}', 'history.intro': 'The service keeps the most recent versions. Restoring saves an old version again as the newest one.',
      'history.version': 'Version {n}', 'history.current': 'current', 'history.deleted': 'deleted',
      'history.preview': 'Preview', 'history.restore': 'Restore', 'history.empty': 'There are no versions yet.', 'history.unavailable': 'This version is no longer available.',

      'share.title': 'Vault', 'share.people': 'People with access', 'share.you': 'You', 'share.member': 'Member',
      'share.escrow': 'Faculty key', 'share.escrow.badge': 'Faculty, recovery only',
      'share.status.active': 'Active', 'share.status.invited': 'Invite not used yet, valid until {time}', 'share.status.expired': 'Invite expired',
      'share.status.redeemed': 'Joined {time}', 'share.status.renewal': 'New keys waiting for approval', 'share.addedByFaculty': 'Added by the faculty during a recovery',
      'share.revoke': 'Revoke', 'share.cancelInvite': 'Cancel invite', 'share.role': 'Access of {label}', 'share.status.opened': 'Invite opened with its code, not redeemed yet, valid until {time}',
      'share.revoke.invite.text': 'The code for {label} has already been used to open the invite, so it can no longer be withdrawn quietly. To make the code worthless, all stored data, including the history, is re-encrypted with a new key. This can take a while: keep this window open. If it is interrupted, it continues the next time you unlock.',
      'share.invite.title': 'Invite someone', 'share.invite.role': 'Access', 'share.invite.label': 'Label (optional)',
      'share.invite.label.hint': 'A note for you, for example a first name. It is stored encrypted in this vault.', 'share.invite.create': 'Create invite code',
      'share.invite.sandboxLate': 'The sandbox is emptied at {time}. An invite must be valid for at least one hour, so none can be created now.',
      'share.invite.busy': 'Creating the invite…', 'share.invite.result': 'Invite code', 'share.invite.until': 'Valid until {time}.',
      'share.invite.hint': 'Hand the code over in person, or through a different channel than the one the data of this app is about. Whoever holds the code can join once. You can cancel it until it is used.',
      'share.invite.another': 'Create another invite', 'share.revoke.title': 'Revoke access?',
      'share.revoke.text': '{label} loses access immediately. All stored data, including the history, is then re-encrypted with a new key. This can take a while: keep this window open. If it is interrupted, it continues the next time you unlock.',
      'share.revoke.confirm': 'Revoke access', 'share.slotId': 'ID {id}', 'share.otherOwner': 'Other owner',
      'share.labels.hint': 'Names are notes kept inside the vault. Anyone with write access can change them, so check the ID before you revoke someone.',
      'share.revoke.id': 'ID of this access: {id}. Compare it with the list before you confirm.',
      'share.revoke.owner.text': '{label} loses access immediately, including the right to manage who has access. All stored data, including the history, is then re-encrypted with a new key. Continue only if this access was added by mistake or can no longer be trusted. This can take a while: keep this window open. If it is interrupted, it continues the next time you unlock.',
      'share.revoke.progress': 'Re-encrypting: {done} of {total}', 'share.revoke.starting': 'Preparing the new key…', 'share.revoke.done': 'Access revoked. All data is re-encrypted.',
      'share.revoke.partial': 'Access revoked. The re-encryption continues the next time you unlock.',
      'share.rekey.pending': 'Re-encryption of older data is not finished.', 'share.rekey.continue': 'Continue now', 'share.recovered.title': 'The faculty added an owner access',
      'share.recovered.text': 'After a recovery request, the faculty added a new owner access to this vault. If you did not expect this, contact the faculty. Your own access stays valid, and you can revoke the added owner access in the vault dialog (Vault). You have to confirm before you can change who has access.',
      'share.recovered.ack': 'I know about this', 'share.recovery.title': 'A recovery of this vault was requested',
      'share.recovery.text': 'Requested {time}. After {ready} the faculty can restore access for the requester. If nobody asked on your behalf, cancel the request now.',
      'share.recovery.cancel': 'Cancel the request', 'share.recovery.keep': 'Leave it as it is', 'share.recovery.cancelled': 'The recovery request was cancelled.', 'share.me.title': 'My access',
      'share.me.role': 'You have access as: {role}.', 'share.me.onlyOwner': 'Only the owner can invite people or change who has access.',
      'share.me.passphrase': 'Change passphrase', 'share.me.passphrase.new': 'New passphrase', 'share.me.passphrase.submit': 'Change passphrase',
      'share.me.passphrase.done': 'Passphrase changed. Use the new one from now on.',
      'share.me.lock': 'Lock now',
      'share.me.lock.hint': 'Removes all data from the memory of this page. Unlocking needs your passphrase.', 'share.me.sheet': 'Show access sheet',
      'share.me.sheet.hint': 'Shows your access ID again, to print or save.', 'share.me.export': 'Export everything (ZIP, unencrypted)',
      'share.me.export.hint': 'All records of this vault in one ZIP file. The file is not encrypted: keep it safe.',
      'share.error.recoveryAck': 'Confirm the notice about the faculty access first.', 'share.error.generic': 'This did not work: {message}',

      'sandbox.prefix': 'Sandbox: ', 'sandbox.banner': 'Sandbox for testing. Anyone can create a vault here, and all vaults are deleted every night (next: {time}). Do not store real data.',
      'sandbox.bar': 'Sandbox', 'sandbox.share.escrow': 'Part of every vault and cannot be removed. The sandbox offers no recovery.',
      'sandbox.create.escrow': 'The server stores only encrypted data. The faculty\'s recovery key is part of every vault here too, but the sandbox offers no recovery: a lost passphrase means the vault is gone (it is deleted tonight anyway).',
      'sandbox.create.submit': 'Create sandbox vault', 'sandbox.sheet.title': 'Sandbox access (deleted tonight)', 'sandbox.sheet.note': 'No recovery in the sandbox; this vault is deleted tonight.',
      'sandbox.emptied': 'The sandbox was emptied on {date}. Create a new vault.', 'sandbox.nightly': 'The sandbox is emptied every night.',
      'migrate.title': 'Take over data from the earlier version',
      'migrate.question': 'This browser holds {count} entries from an earlier version of this app. They are unencrypted and exist only on this device. Copy them into your vault (access ID ending in {vault})? The old entries stay in this browser until you have checked the copy in the app and confirm the deletion at the next start. If you choose "Not now", nothing changes and you are asked again next time.',
      'migrate.question.sandbox': 'This browser holds {count} entries from an earlier version of this app. They are unencrypted and exist only on this device. Copy them into your vault (access ID ending in {vault})? Sandbox: the old data stays in this browser.',
      'migrate.backup.failed': 'The backup could not be created: {why}', 'migrate.backup': 'Download a copy of the old data first (not encrypted)',
      'migrate.yes': 'Take over', 'migrate.no': 'Not now', 'migrate.progress': 'Taking over: {done} of {total}', 'migrate.delete': 'Delete the old entries',
      'migrate.done': '{n} entries were copied into your vault. Check them in the app. The old entries are still in this browser; the next start asks whether to delete them.',
      'migrate.done.sandbox': '{n} entries were copied into your vault. The old data stays in this browser.',
      'migrate.cleanup': '{count} entries of an earlier version of this app are still stored in this browser, unencrypted. Copies of them are in your vault. Is everything in the app? Then delete the old entries from this browser. Deleting cannot be undone.', 'migrate.deleted': '{n} old entries were deleted from this browser.',
      'migrate.failed': 'Taking over the old data failed. What is in your vault is safe, and what is left of the old data stays in this browser. You can download a copy of it. If this happens again, tell the person who runs this app.',
      'err.sandboxDisabled': 'The sandbox is not available at the moment.',
    },
    de: {
      'common.close': 'Schließen', 'common.cancel': 'Abbrechen', 'common.continue': 'Weiter', 'common.copy': 'Kopieren', 'common.copied': 'Kopiert', 'common.retry': 'Erneut versuchen',
      'err.build': 'Dieses Fenster konnte nicht aufgebaut werden. Lade die Seite neu; passiert es wieder, sag den Entwicklern dieser App Bescheid.',
      'common.loading': 'Verbindung zum Speicherdienst wird aufgebaut …', 'common.notifications': 'Hinweise', 'common.thisEntry': 'diesen Eintrag', 'common.back': 'Zurück',

      'unlock.title': 'Daten entsperren', 'unlock.app': 'App: {name}',
      'unlock.intro': 'Geben Sie Ihre Zugangskennung und Ihre Passphrase ein. Ihre Daten werden auf diesem Gerät verschlüsselt, bevor sie gespeichert werden.', 'unlock.accessId': 'Zugangskennung',
      'unlock.accessId.hint': 'Fünf Gruppen mit je vier Zeichen. Sie steht auf Ihrem Zugangsblatt.', 'unlock.passphrase': 'Passphrase', 'unlock.submit': 'Entsperren',
      'unlock.busy': 'Ihr Schlüssel wird berechnet. Das dauert einen Moment …', 'unlock.toCreate': 'Neuen Tresor anlegen', 'unlock.toRedeem': 'Ich habe einen Einladungscode',
      'unlock.recoveryEntered': 'Das sieht nach einem Notfallcode aus, nicht nach einer Zugangskennung. Der Notfallcode wird nur für das Wiederherstellungsverfahren der Fakultät gebraucht.',

      'create.title': 'Tresor anlegen',
      'create.intro': 'Ihre Daten werden auf diesem Gerät mit einem Schlüssel verschlüsselt, der aus Ihrer Passphrase abgeleitet wird. Nur Sie und die Personen, die Sie einladen, können sie öffnen.',
      'create.joinCode': 'Beitrittscode', 'create.joinCode.hint': 'Den Beitrittscode erhalten Sie von der Person, die diese App betreibt.',
      'create.passphrase': 'Passphrase', 'create.repeat': 'Passphrase wiederholen',
      'create.passphrase.hint': 'Mindestens 12 Zeichen. Vier oder mehr unzusammenhängende Wörter eignen sich gut. Der Server kann eine vergessene Passphrase nicht zurücksetzen.',
      'escrow.title': 'Wer kann Ihre Daten lesen?',
      'escrow.text': 'Die Daten sind Ende-zu-Ende-verschlüsselt; die Fakultät verwahrt für Notfälle einen Wiederherstellungsschlüssel. Wer diesen Schlüssel besitzt, könnte technisch jeden Tresor entschlüsseln; die Fakultät nutzt ihn nur in einem dokumentierten Verfahren mit einer Wartezeit von 72 Stunden.',
      'create.privacy': 'Datenschutzinformationen', 'create.submit': 'Tresor anlegen', 'create.busy': 'Ihr Tresor wird angelegt. Das dauert einen Moment …',
      'create.suspended': 'Diese App ist von der Fakultät pausiert. Neue Tresore können nicht angelegt werden.',
      'create.back': 'Ich habe schon einen Tresor',

      'pw.show': 'Passphrase anzeigen', 'pw.tooShort': 'Mindestens 12 Zeichen sind nötig (bisher {n}).', 'pw.mismatch': 'Die beiden Passphrasen sind verschieden.',
      'pw.common': 'Diese Passphrase steht auf Listen sehr häufiger Passwörter. Wählen Sie eine andere.',
      'pw.weak': 'Diese Passphrase ist zu leicht zu erraten. Nehmen Sie mehrere unzusammenhängende Wörter.',
      'pw.weak.noBreachCheck': 'Diese Passphrase ist nicht stark genug: Die Prüfung auf bekannte Datenlecks ist nicht verfügbar, deshalb braucht es eine stärkere Passphrase. Nehmen Sie mehr, längere und unzusammenhängende Wörter.',
      'pw.pwned': 'Diese Passphrase kommt {count}-mal in bekannten Datenlecks vor. Wählen Sie eine andere.',
      'pw.hibp.unavailable': 'Die Prüfung auf Datenlecks war nicht erreichbar, daher wurde diese Passphrase nicht gegen bekannte Datenlecks geprüft.',
      'pw.hibp.checking': 'Prüfung auf bekannte Datenlecks …',
      'pw.hibp.note': 'Die Prüfung auf Datenlecks sendet die ersten fünf Zeichen einer Prüfsumme Ihrer Passphrase an den Server der Fakultät, der in Ihrem Namen bei Pwned Passwords (USA) nachfragt. Der Dienst erfährt weder Ihre Passphrase noch Ihre IP-Adresse.',
      'pw.strength': 'Stärke: {label}', 'pw.label.0': 'sehr schwach', 'pw.label.1': 'schwach', 'pw.label.2': 'mittel', 'pw.label.3': 'gut', 'pw.label.4': 'stark',
      'pw.empty': 'Geben Sie eine Passphrase ein.',

      'sheet.title': 'Zugangsblatt sichern',
      'sheet.intro.owner': 'Zugangskennung und Passphrase brauchen Sie, um Ihre Daten auf einem anderen Gerät zu öffnen. Der Notfallcode ist der einzige Weg zurück, wenn Sie die Passphrase vergessen.',
      'sheet.intro.member': 'Zugangskennung und Passphrase brauchen Sie, um die Daten auf einem anderen Gerät zu öffnen.',
      'sheet.app': 'App', 'sheet.accessId': 'Zugangskennung', 'sheet.recovery': 'Notfallcode', 'sheet.created': 'Angelegt',
      'sheet.service': 'Dienst', 'sheet.access': 'Zugriff', 'sheet.print': 'Zugangsblatt drucken',
      'sheet.download': 'Zugangsblatt herunterladen (HTML)',
      'sheet.passphrase.note': 'Ihre Passphrase steht nicht auf diesem Blatt. Merken Sie sie sich oder verwahren Sie sie in einem Passwortmanager.',
      'sheet.recovery.note': 'Bewahren Sie das Blatt getrennt von diesem Rechner auf. Wer den Notfallcode hat, kann eine Wiederherstellung beantragen; Sie erfahren davon beim Entsperren und können sie während der Wartezeit von 72 Stunden abbrechen.',
      'sheet.confirm.owner': 'Ich habe das Zugangsblatt und den Notfallcode gesichert.', 'sheet.confirm.member': 'Ich habe meine Zugangskennung gesichert.',
      'sheet.hibp.skipped': 'Hinweis: Die Prüfung auf Datenlecks war nicht erreichbar, daher wurde Ihre Passphrase nicht gegen bekannte Datenlecks geprüft.',
      'sheet.page.title': 'Zugangsblatt', 'sheet.page.print': 'Diese Seite drucken',

      'redeem.title': 'Mit Einladungscode beitreten', 'redeem.intro': 'Geben Sie den erhaltenen Einladungscode ein und wählen Sie Ihre eigene Passphrase. Ein Einladungscode funktioniert nur einmal.',
      'redeem.code': 'Einladungscode', 'redeem.code.hint': '48 Zeichen in Vierergruppen.', 'redeem.submit': 'Beitreten',
      'redeem.busy': 'Der Beitritt läuft. Das dauert einen Moment …', 'redeem.done': 'Sie haben jetzt Zugriff',
      'redeem.role.write': 'Sie können die Daten lesen und ändern.', 'redeem.role.read': 'Sie können die Daten lesen, aber nicht ändern.', 'redeem.back': 'Ich habe schon eine Zugangskennung',

      'role.owner': 'Eigentümer', 'role.write': 'Darf bearbeiten', 'role.read': 'Nur lesen',

      'err.notFound': 'Diese Zugangskennung ist unbekannt, oder der Zugang wurde entfernt.', 'err.badId': 'Diese Zugangskennung ist ungültig. Prüfen Sie sie auf Tippfehler.',
      'err.wrongPass': 'Die Passphrase passt nicht zu dieser Zugangskennung.', 'err.revoked': 'Die Eigentümerin oder der Eigentümer der Daten hat diesen Zugang entfernt.',
      'err.expired': 'Diese Einladung ist abgelaufen. Bitten Sie um eine neue.',
      'err.vaultDeleted': 'Dieser Tresor wurde gelöscht. Er wird nach 30 Tagen endgültig entfernt. Wenden Sie sich an die Person, die die App betreibt, falls das ein Versehen war.',
      'err.alreadyRedeemed': 'Diese Einladung wurde schon benutzt. Entsperren Sie stattdessen mit Zugangskennung und Passphrase.',
      'err.rate': 'Zu viele Versuche. Warten Sie einen Moment und versuchen Sie es erneut.',
      'err.offline': 'Der Speicherdienst ist nicht erreichbar. Prüfen Sie Ihre Internetverbindung und versuchen Sie es erneut.',
      'err.integrity': 'Eine Sicherheitsprüfung ist fehlgeschlagen: Die Daten des Servers passen nicht zu dem, was dieses Gerät erwartet ({code}). Geben Sie keine neuen Daten ein und wenden Sie sich an die Person, die diese App betreibt.',
      'err.rollback': 'Der Server hat ältere Daten gezeigt, als dieses Gerät schon gesehen hat. Das kann ein Fehler oder ein Angriff sein. Machen Sie nicht weiter und wenden Sie sich an die Person, die diese App betreibt.',
      'err.generic': 'Etwas ist schiefgegangen: {message}',
      'err.invite.invalid': 'Dieser Einladungscode ist ungültig. Er hat 48 Zeichen; prüfen Sie ihn auf Tippfehler.',
      'err.joinCode': 'Der Beitrittscode ist nicht korrekt.', 'err.joinCode.missing': 'Geben Sie den Beitrittscode ein.',
      'err.vaultLimit': 'Diese App kann derzeit keine neuen Nutzenden aufnehmen. Wenden Sie sich an die Person, die sie betreibt.',
      'err.noPins': 'In diesem Build der Speicherbibliothek fehlt der Schlüssel der Fakultät. Wenden Sie sich an die Autorin oder den Autor der App.',
      'err.accessId.missing': 'Geben Sie Ihre Zugangskennung ein.', 'err.passphrase.missing': 'Geben Sie Ihre Passphrase ein.',
      'err.scope': 'Diese App ist beim Speicherdienst nicht registriert.',

      'note.advisory': 'Diese App nutzt eine veraltete Version der Speicherbibliothek. Bitten Sie die Autorin oder den Autor um eine Aktualisierung.',
      'note.newDevice': 'Dieses Gerät ist neu für Ihren Tresor. Das ist normal.',
      'note.stateInvalid': 'Der auf diesem Gerät gespeicherte Sicherheitsvermerk war beschädigt oder verändert und wurde zurückgesetzt.',
      'note.readOnly': 'Der Speicherdienst ist im Nur-Lese-Modus. Änderungen können derzeit nicht gespeichert werden.',
      'note.suspended': 'Diese App ist von der Fakultät pausiert. Sie können Ihre Daten lesen, aber keine Änderungen speichern.',
      'note.redeemed.one': 'Eine Einladung wurde eingelöst.', 'note.redeemed.other': '{n} Einladungen wurden eingelöst.',
      'note.rekey': 'Gespeicherte Daten werden nach einem Zugriffsentzug neu verschlüsselt: {done} erledigt, {left} offen.',
      'note.rekey.done': 'Neuverschlüsselung abgeschlossen. Entzogene Zugänge können keine gespeicherten Daten mehr öffnen.',
      'note.rekey.failed': 'Die Neuverschlüsselung wurde unterbrochen. Sie läuft beim nächsten Entsperren weiter.',
      'note.offline': 'Speichern fehlgeschlagen: Der Speicherdienst ist nicht erreichbar. Ihre letzten Änderungen gibt es nur in diesem Fenster.',
      'offline.title': 'Nicht gespeichert',
      'end.ok': 'OK', 'end.revoked.title': 'Ihr Zugang wurde entfernt', 'end.lock.title': 'Nicht alles ist gespeichert',
      'end.lock.text': 'Diese Änderungen konnten noch nicht gespeichert werden. Laden Sie sie vor dem Sperren als Sicherung herunter; danach wird die Seite neu geladen.',
      'end.lock.anyway': 'Trotzdem sperren', 'end.reload': 'Die Seite wird neu geladen, wenn Sie fortfahren.',
      'note.backup': 'Nicht gespeicherte Werte herunterladen (Sicherung)', 'note.backup.none': 'Es gibt noch nichts zu sichern.', 'note.quota': 'Speichern fehlgeschlagen: {message}',
      'note.revoked': 'Ihr Zugang zu diesem Tresor wurde entfernt. Die Daten auf diesem Gerät sind gesperrt.',
      'integrity.title': 'Eine Sicherheitsprüfung ist fehlgeschlagen', 'note.redeemed.title': 'Neuer Zugang',
      'note.forbidden': 'Dieser Zugang ist nur lesend, die Änderung wurde nicht gespeichert.', 'note.exporting': 'Export läuft: {done} von {total}',
      'note.exported': 'Export abgeschlossen: {n} Datensätze.', 'note.version': 'Diese App braucht eine neuere Version der Speicherbibliothek: {message}',

      'conflict.title': 'Ein anderes Gerät oder eine andere Person hat eine neuere Version gespeichert',
      'conflict.intro': 'Ein anderes Gerät oder eine andere Person hat {name} geändert, nachdem Sie es zuletzt geladen haben. Wählen Sie, welche Version bleibt. Nichts geht verloren: Die Version, die Sie nicht behalten, bleibt im Verlauf.',
      'conflict.theirs': 'Die andere Version', 'conflict.mine': 'Ihre Version (noch nicht gespeichert)', 'conflict.saved': 'gespeichert {time}',
      'conflict.theirsDeleted': 'Dieser Eintrag wurde von jemand anderem gelöscht.', 'conflict.mineDeleted': 'Sie wollten diesen Eintrag löschen.',
      'conflict.noTheirs': 'Es gibt keine gespeicherte Version.', 'conflict.keepTheirs': 'Andere behalten', 'conflict.keepMine': 'Meine behalten',
      'conflict.file': 'Datei ({mime}), {size}', 'conflict.truncated': '(gekürzt)', 'conflict.delete.title': 'Dieser Eintrag wurde zwischenzeitlich geändert',
      'conflict.delete.intro': 'Ein anderes Gerät oder eine andere Person hat {name} geändert, nachdem Sie es zuletzt geladen haben, und Sie wollten es löschen. Trotzdem löschen oder die neuere Version behalten? Ein gelöschter Eintrag bleibt im Verlauf.',
      'conflict.delete.keepMine': 'Trotzdem löschen', 'conflict.delete.keepTheirs': 'Eintrag behalten',

      'history.title': 'Verlauf von {name}', 'history.intro': 'Der Dienst bewahrt die letzten Versionen auf. Beim Wiederherstellen wird eine alte Version erneut als neueste gespeichert.',
      'history.version': 'Version {n}', 'history.current': 'aktuell', 'history.deleted': 'gelöscht',
      'history.preview': 'Vorschau', 'history.restore': 'Wiederherstellen', 'history.empty': 'Es gibt noch keine Versionen.', 'history.unavailable': 'Diese Version ist nicht mehr verfügbar.',

      'share.title': 'Tresor', 'share.people': 'Personen mit Zugriff', 'share.you': 'Sie', 'share.member': 'Mitglied',
      'share.escrow': 'Schlüssel der Fakultät', 'share.escrow.badge': 'Fakultät, nur zur Wiederherstellung',
      'share.status.active': 'Aktiv', 'share.status.invited': 'Einladung noch nicht benutzt, gültig bis {time}',
      'share.status.expired': 'Einladung abgelaufen', 'share.status.redeemed': 'Beigetreten {time}', 'share.status.renewal': 'Neue Schlüssel warten auf Bestätigung',
      'share.addedByFaculty': 'Von der Fakultät bei einer Wiederherstellung hinzugefügt',
      'share.revoke': 'Entziehen', 'share.cancelInvite': 'Einladung zurückziehen', 'share.role': 'Zugriff von {label}',
      'share.status.opened': 'Einladung mit ihrem Code geöffnet, noch nicht eingelöst, gültig bis {time}',
      'share.revoke.invite.text': 'Der Code für {label} wurde bereits benutzt, um die Einladung zu öffnen. Deshalb lässt sie sich nicht mehr unbemerkt zurückziehen. Damit der Code wertlos wird, werden alle gespeicherten Daten samt Verlauf mit einem neuen Schlüssel neu verschlüsselt. Das kann dauern: Lassen Sie dieses Fenster geöffnet. Bei einer Unterbrechung läuft es beim nächsten Entsperren weiter.',
      'share.invite.title': 'Jemanden einladen', 'share.invite.role': 'Zugriff', 'share.invite.label': 'Bezeichnung (optional)',
      'share.invite.label.hint': 'Eine Notiz für Sie, zum Beispiel ein Vorname. Sie wird verschlüsselt in diesem Tresor gespeichert.', 'share.invite.create': 'Einladungscode erzeugen',
      'share.invite.sandboxLate': 'Die Testumgebung wird um {time} geleert. Eine Einladung muss mindestens eine Stunde gültig sein, deshalb kann jetzt keine erzeugt werden.',
      'share.invite.busy': 'Die Einladung wird erzeugt …', 'share.invite.result': 'Einladungscode', 'share.invite.until': 'Gültig bis {time}.',
      'share.invite.hint': 'Geben Sie den Code persönlich weiter oder über einen anderen Kanal als den, um dessen Daten es in dieser App geht. Wer den Code hat, kann einmal beitreten. Sie können ihn zurückziehen, solange er nicht benutzt wurde.',
      'share.invite.another': 'Weitere Einladung erzeugen', 'share.revoke.title': 'Zugriff entziehen?',
      'share.revoke.text': '{label} verliert sofort den Zugriff. Alle gespeicherten Daten samt Verlauf werden danach mit einem neuen Schlüssel neu verschlüsselt. Das kann dauern: Lassen Sie dieses Fenster geöffnet. Bei einer Unterbrechung läuft es beim nächsten Entsperren weiter.',
      'share.revoke.confirm': 'Zugriff entziehen', 'share.slotId': 'ID {id}', 'share.otherOwner': 'Weiterer Eigentümer',
      'share.labels.hint': 'Namen sind Notizen im Tresor. Wer Schreibzugriff hat, kann sie ändern. Prüfen Sie deshalb die ID, bevor Sie jemandem den Zugriff entziehen.',
      'share.revoke.id': 'ID dieses Zugangs: {id}. Vergleichen Sie sie mit der Liste, bevor Sie bestätigen.',
      'share.revoke.owner.text': '{label} verliert sofort den Zugriff, auch das Recht, den Zugriff anderer zu verwalten. Alle gespeicherten Daten samt Verlauf werden danach mit einem neuen Schlüssel neu verschlüsselt. Fahren Sie nur fort, wenn dieser Zugang irrtümlich hinzugefügt wurde oder nicht mehr vertrauenswürdig ist. Das kann dauern: Lassen Sie dieses Fenster geöffnet. Bei einer Unterbrechung läuft es beim nächsten Entsperren weiter.',
      'share.revoke.progress': 'Neuverschlüsselung: {done} von {total}', 'share.revoke.starting': 'Der neue Schlüssel wird vorbereitet …',
      'share.revoke.done': 'Zugriff entzogen. Alle Daten sind neu verschlüsselt.', 'share.revoke.partial': 'Zugriff entzogen. Die Neuverschlüsselung läuft beim nächsten Entsperren weiter.',
      'share.rekey.pending': 'Die Neuverschlüsselung älterer Daten ist nicht abgeschlossen.', 'share.rekey.continue': 'Jetzt fortsetzen',
      'share.recovered.title': 'Die Fakultät hat einen Eigentümer-Zugang hinzugefügt',
      'share.recovered.text': 'Nach einem Wiederherstellungsantrag hat die Fakultät diesem Tresor einen neuen Eigentümer-Zugang hinzugefügt. Falls Sie damit nicht gerechnet haben, wenden Sie sich an die Fakultät. Ihr eigener Zugang bleibt gültig, und Sie können den hinzugefügten Eigentümer-Zugang im Tresor-Dialog (Tresor) entziehen. Sie müssen das bestätigen, bevor Sie ändern können, wer Zugriff hat.',
      'share.recovered.ack': 'Ich weiß Bescheid', 'share.recovery.title': 'Für diesen Tresor wurde eine Wiederherstellung beantragt',
      'share.recovery.text': 'Beantragt {time}. Ab {ready} kann die Fakultät den Zugang für die antragstellende Person wiederherstellen. Falls niemand in Ihrem Auftrag gefragt hat, brechen Sie den Antrag jetzt ab.',
      'share.recovery.cancel': 'Antrag abbrechen', 'share.recovery.keep': 'So belassen', 'share.recovery.cancelled': 'Der Wiederherstellungsantrag wurde abgebrochen.', 'share.me.title': 'Mein Zugang',
      'share.me.role': 'Ihr Zugriff: {role}.', 'share.me.onlyOwner': 'Nur die Eigentümerin oder der Eigentümer kann Personen einladen oder den Zugriff ändern.',
      'share.me.passphrase': 'Passphrase ändern', 'share.me.passphrase.new': 'Neue Passphrase', 'share.me.passphrase.submit': 'Passphrase ändern',
      'share.me.passphrase.done': 'Passphrase geändert. Verwenden Sie ab jetzt die neue.', 'share.me.lock': 'Jetzt sperren',
      'share.me.lock.hint': 'Entfernt alle Daten aus dem Speicher dieser Seite. Zum Entsperren brauchen Sie Ihre Passphrase.',
      'share.me.sheet': 'Zugangsblatt anzeigen', 'share.me.sheet.hint': 'Zeigt Ihre Zugangskennung noch einmal, zum Ausdrucken oder Speichern.',
      'share.me.export': 'Alles exportieren (ZIP, unverschlüsselt)',
      'share.me.export.hint': 'Alle Datensätze dieses Tresors in einer ZIP-Datei. Die Datei ist nicht verschlüsselt: Bewahren Sie sie sicher auf.',
      'share.error.recoveryAck': 'Bestätigen Sie zuerst den Hinweis zum Zugang der Fakultät.', 'share.error.generic': 'Das hat nicht geklappt: {message}',

      'sandbox.prefix': 'Testumgebung: ',
      'sandbox.banner': 'Testumgebung. Hier kann jede Person einen Tresor anlegen, und alle Tresore werden jede Nacht gelöscht (das nächste Mal: {time}). Speichern Sie hier keine echten Daten.',
      'sandbox.bar': 'Testumgebung', 'sandbox.share.escrow': 'Gehört zu jedem Tresor und kann nicht entfernt werden. Die Testumgebung bietet keine Wiederherstellung.',
      'sandbox.create.escrow': 'Der Server speichert nur verschlüsselte Daten. Der Wiederherstellungsschlüssel der Fakultät gehört auch hier zu jedem Tresor, aber die Testumgebung bietet keine Wiederherstellung: Ist die Passphrase verloren, ist der Tresor verloren (er wird ohnehin heute Nacht gelöscht).',
      'sandbox.create.submit': 'Testtresor anlegen', 'sandbox.sheet.title': 'Zugang zur Testumgebung (wird heute Nacht gelöscht)',
      'sandbox.sheet.note': 'Keine Wiederherstellung in der Testumgebung; dieser Tresor wird heute Nacht gelöscht.',
      'sandbox.emptied': 'Die Testumgebung wurde am {date} geleert. Legen Sie einen neuen Tresor an.', 'sandbox.nightly': 'Die Testumgebung wird jede Nacht geleert.',
      'migrate.title': 'Daten der früheren Version übernehmen',
      'migrate.question': 'In diesem Browser liegen {count} Einträge aus einer früheren Version dieser App, unverschlüsselt und nur auf diesem Gerät. Sollen sie in Ihren Tresor (Zugangskennung endet auf {vault}) kopiert werden? Die alten Einträge bleiben in diesem Browser, bis Sie die Kopie in der App geprüft haben und beim nächsten Start das Löschen bestätigen. Wenn Sie „Später“ wählen, ändert sich nichts und Sie werden beim nächsten Start wieder gefragt.',
      'migrate.question.sandbox': 'In diesem Browser liegen {count} Einträge aus einer früheren Version dieser App, unverschlüsselt und nur auf diesem Gerät. Sollen sie in Ihren Tresor (Zugangskennung endet auf {vault}) kopiert werden? Testumgebung: Die alten Daten bleiben in diesem Browser.',
      'migrate.backup.failed': 'Die Sicherung konnte nicht erstellt werden: {why}',
      'migrate.backup': 'Zuerst eine Kopie der alten Daten herunterladen (nicht verschlüsselt)', 'migrate.yes': 'Übernehmen', 'migrate.no': 'Später', 'migrate.delete': 'Alte Einträge löschen',
      'migrate.progress': 'Wird übernommen: {done} von {total}',
      'migrate.done': '{n} Einträge wurden in Ihren Tresor kopiert. Prüfen Sie sie in der App. Die alten Einträge liegen noch in diesem Browser; beim nächsten Start werden Sie gefragt, ob sie gelöscht werden sollen.',
      'migrate.done.sandbox': '{n} Einträge wurden in Ihren Tresor kopiert. Die alten Daten bleiben in diesem Browser.',
      'migrate.cleanup': 'In diesem Browser liegen noch {count} Einträge einer früheren Version dieser App, unverschlüsselt. Kopien davon sind in Ihrem Tresor. Ist in der App alles da? Dann löschen Sie die alten Einträge aus diesem Browser. Das Löschen lässt sich nicht rückgängig machen.', 'migrate.deleted': '{n} alte Einträge wurden aus diesem Browser gelöscht.',
      'migrate.failed': 'Die Übernahme der alten Daten ist fehlgeschlagen. Was in Ihrem Tresor liegt, ist sicher, und was von den alten Daten übrig ist, bleibt in diesem Browser. Sie können eine Sicherung herunterladen. Wenn das wieder passiert, melden Sie sich bei der Person, die diese App betreibt.',
      'err.sandboxDisabled': 'Die Testumgebung ist im Moment nicht verfügbar.',
    }
  };

  // <html lang> decides (de* is German, anything else English); without it navigator.language.
  function detectLang() {
    var l = (typeof document !== 'undefined' && document.documentElement && document.documentElement.getAttribute('lang')) ||
      (typeof navigator !== 'undefined' && (navigator.language || (navigator.languages && navigator.languages[0]))) || 'en';
    return String(l).toLowerCase().indexOf('de') === 0 ? 'de' : 'en';
  }
  function makeT(lang) {
    var dict = TEXT[lang] || TEXT.en;
    return function t(key, params) {
      var s = dict[key];
      if (s === undefined) s = TEXT.en[key];
      if (s === undefined) return key;
      return params ? fmt(s, params) : s;
    };
  }
  function makeLocale(lang) { return lang === 'de' ? 'de-DE' : 'en-GB'; }
  function formatDate(sec, lang) {
    try { return new Date(sec * 1000).toLocaleDateString(makeLocale(lang), { dateStyle: 'medium' }); } catch (e) { return new Date(sec * 1000).toISOString().slice(0, 10); }
  }
  function formatTime(sec, lang) {
    try {
      return new Date(sec * 1000).toLocaleString(makeLocale(lang), { dateStyle: 'medium', timeStyle: 'short' });
    } catch (e) { return new Date(sec * 1000).toISOString(); }
  }

  // ------------------------------------------------------------------------------------------------------------
  // 3. Passphrase rules (PLAN 5.3): length, strength estimate, small common-password list, breach check
  // ------------------------------------------------------------------------------------------------------------
  var MIN_PASSPHRASE = 12;
  var BLOCK_BITS = 40;   // estimates below this are refused
  var STRICT_BITS = 48;  // estimates below this are refused too when the breach check could not be done (service unreachable)

  // Most common passwords (English and German, with typical leet and keyboard patterns). Used for exact matches.
  var COMMON_EXACT = ('password passwort passw0rd p@ssw0rd p@ssword pa55word pa55w0rd kennwort 123456 1234567 12345678 123456789 1234567890 ' +
    '12345678910 111111 000000 123123 654321 666666 121212 112233 987654321 123321 1q2w3e4r 1q2w3e4r5t 1qaz2wsx zaq12wsx q1w2e3r4 ' +
    'abc123 abcd1234 qwe123 qwerty qwertz qwertyuiop qwertzuiop asdfgh asdfghjkl yxcvbnm zxcvbnm azerty letmein welcome monkey dragon ' +
    'master sunshine princess football baseball shadow superman batman trustno1 iloveyou admin administrator login starwars hallo ' +
    'hallo123 hallowelt schatz schatzi fussball bayern geheim michael jordan harley ranger hunter ashley jennifer jessica ' +
    'charlie thomas daniel andrew joshua robert freedom whatever cheese secret changeme default test testtest testing guest ' +
    'internet computer samsung mustang soccer hockey killer pepper tigger buster ginger summer winter flower matrix naruto pokemon ' +
    // German: the most common choices (also without umlauts), love phrases, keyboard and club names; trailing digits are ignored
    'ichliebedich ichliebedichso ichhasseeuch ichbinich ichbinhier ichweissnicht ichwillnicht ichbindoof meinschatz meinschatzi meinpasswort ' +
    'meinpassword meinpasswort1 meingeheimnis geheimespasswort geheimnis passwort1234 passwortpasswort kennwort1234 hallo1234 hallowelt ' +
    'hallohallo guten gutenmorgen gutentag gutenabend sonnenschein sonnenblume regenbogen schmetterling einhorn mausebaer mausebaerchen ' +
    'schatzilein liebling lieblingsmensch mamaundpapa mutter vater familie deutschland deutschland1 fussballfan fcbayern fcbayernmuenchen ' +
    'bayernmuenchen borussia borussiadortmund werderbremen hamburgersv eintracht schalke04 sommer sommerferien winterzeit herbstwind ' +
    'fruehling sonne mond sterne wasserfall computer1 passwortmanager zugangscode zugangsdaten benutzer benutzername startseite uni ' +
    'unibamberg bamberg1 wiai wiaibamberg zeitnotizen testtesttest abc12345 abcdefgh abcdefghijkl qwertz123 qwertzuiop1 asdf1234 ' +
    'asdfghjkl1 yxcvbnm123 iloveyou1 ichliebedichmein dubistmeinschatz duundich wirliebenunsere').split(' ');

  // Common words (English and German) the estimate treats as cheap building blocks.
  var COMMON_WORDS = ('love hello welcome monkey dragon master sunshine princess football baseball shadow superman batman iloveyou ' +
    'admin login letmein secret trust summer winter spring autumn flower soccer hockey basketball computer internet freedom whatever ' +
    'cheese chocolate coffee banana orange apple lemon cookie butter hunter ranger tiger lion eagle wolf bear horse mustang ferrari ' +
    'porsche mercedes cowboy pirate ninja wizard magic secure killer maverick starwars matrix pokemon naruto harry potter jordan ' +
    'michael jennifer jessica ashley daniel thomas andrew joshua robert charlie buster hannah nicole samantha tigger snoopy pepper ' +
    'jesus angel silver golden purple yellow green black white blue red heaven hell money cash dollar friend family mother father ' +
    'sister brother happy lucky smile forever always never everything nothing someone anything people queen king prince knight castle ' +
    'dream night moon star stars sun rain snow fire water earth wind game gamer player lord god house home work school teacher ' +
    'student college office phone mobile email mail user guest test testing tester default change changeme passwort password pass word ' +
    'hallo geheim schatz schatzi liebe liebling sommer winter fruehling fruhling herbst sonne mond sterne blume blumen fussball fussball ' +
    'bayern muenchen munchen dortmund schalke hertha berlin hamburg koeln frankfurt stuttgart bamberg nuernberg nurnberg franken ' +
    'deutschland deutsch hund katze maus pferd baer adler drache ritter prinzessin koenig kaiser engel himmel hoelle teufel mutter vater ' +
    'schwester bruder oma opa freund freundin familie glueck gluecklich lachen immer niemals alles nichts haus auto fahrrad kuchen ' +
    'wasser feuer erde luft regen schnee nacht tag morgen abend montag dienstag mittwoch donnerstag freitag samstag sonntag januar ' +
    'februar maerz april mai juni juli august september oktober november dezember uni universitaet student studium professor wiai psi ' +
    'otto friedrich schule lehrer arbeit buero rechner tastatur handy telefon netz bier wein kaffee schokolade pizza nudeln mein meine ' +
    'dein deine bitte danke gut super toll cool echt klar blau rot gruen gelb schwarz weiss lila orange hallo hello hey hi ich du wir ' +
    'ihr sie und der die das ein eine mit von zum zur ist sind the and you your for with this that have not are was were ' +
    // German function words and everyday words that make up most weak phrases
    'dich mich dir mir uns euch ihn ihm liebe lieben lieb hab habe haben bin bist sein war wird will kann soll muss doch noch nicht nur auch ' +
    'aber oder wie was wer wo wann warum mal ja nein jetzt heute gestern morgen hier dort mein meinen meiner dein deinen sehr viel viele alle ' +
    'ganz gern gerne wirklich einfach immer nie niemals leben welt zeit mensch kind kinder frau mann junge maedchen baby hase baerchen ' +
    'schaf kuh ente fisch vogel tier katzen hunde auge hand herz kopf bauch kuss kuessen gluecklich traurig schoen schoene gross klein neu alt ' +
    'stark schnell langsam bunt dunkel hell warm kalt heiss rot gelb schnee eis berg meer see strand wald wiese garten stadt land strasse ' +
    'bruecke turm tor tuer fenster tisch stuhl bett lampe buch zeitung musik lied tanz spiel sport ball tor club verein').split(' ');
  var COMMON_SET = {}, WORD_SET = {};
  COMMON_EXACT.forEach(function (w) { COMMON_SET[w] = true; if (w.length >= 3) WORD_SET[w] = true; });
  COMMON_WORDS.forEach(function (w) { if (w.length >= 3) WORD_SET[w] = true; });
  var WORD_COUNT = Object.keys(WORD_SET).length;
  var KEY_ROWS = ['qwertzuiopue', 'qwertyuiop', 'asdfghjkl', 'yxcvbnm', 'zxcvbnm', '1234567890', 'azertyuiop', 'qaywsxedcrfvtgb', 'qazwsxedcrfvtgbyhn', '1q2w3e4r5t6z7u8i9o0p', '1q2w3e4r5t6y7u8i9o0p'];

  function deleet(s, ones) {
    var map = { '@': 'a', '4': 'a', '3': 'e', '0': 'o', '$': 's', '5': 's', '7': 't', '+': 't', '!': 'i', '8': 'b', '|': 'l', '1': ones };
    return s.replace(/[@43015$7+!8|]/g, function (c) { return map[c]; });
  }
  function dictLookup(seg) { // -> extra bits (0 = plain word, more for variants) or -1 when not a word
    if (WORD_SET[seg]) return 0;
    var a = deleet(seg, 'i'), b = deleet(seg, 'l');
    if (a !== seg && WORD_SET[a]) return 2;
    if (b !== seg && WORD_SET[b]) return 2;
    return -1;
  }
  function litCost(ch) {
    if (/[0-9]/.test(ch)) return 3.3;
    if (/[a-z]/.test(ch)) return 3.6;
    if (/[A-Z]/.test(ch)) return 4.7;
    if (ch.charCodeAt(0) < 128) return 4.8;
    return 4.5;
  }
  // Rough guessing-effort estimate in bits: cheapest way to build the passphrase from literal characters, dictionary
  // words, repeats, sequences, keyboard walks and years. A heuristic, not a proof; documented in PLAN 5.3.
  function estimate(pass) {
    var chars = Array.from(String(pass).slice(0, 200)), n = chars.length;
    var lower = chars.map(function (c) { return c.toLowerCase(); });
    var INF = 1e9, cost = new Array(n + 1), i, k, len;
    for (i = 0; i <= n; i++) cost[i] = INF;
    cost[0] = 0;
    function relax(to, c) { if (c < cost[to]) cost[to] = c; }
    for (i = 0; i < n; i++) {
      if (cost[i] >= INF) continue;
      var base = cost[i];
      relax(i + 1, base + litCost(chars[i]));
      // dictionary words (3 to 16 characters), a little extra for capitals and look-alike digits
      for (len = 3; len <= 16 && i + len <= n; len++) {
        var seg = lower.slice(i, i + len).join('');
        var extra = dictLookup(seg);
        if (extra >= 0) {
          var caps = chars.slice(i, i + len).some(function (c, idx) { return c !== lower[i + idx]; }) ? 1.5 : 0;
          relax(i + len, base + Math.log2(WORD_COUNT) + 1 + extra + caps);
        }
      }
      // years
      if (i + 4 <= n && /^(19|20)[0-9]{2}$/.test(chars.slice(i, i + 4).join(''))) relax(i + 4, base + 6.6);
      // repeats of the previous block of 1 to 8 characters
      for (k = 1; k <= 8 && k <= i; k++) {
        var run = 0;
        while (i + run < n && chars[i + run] === chars[i + run - k]) run++;
        for (len = Math.max(3, k); len <= run; len++) relax(i + len, base + 2 + Math.log2(len / k + 1));
      }
      // sequences (abc, 321) and keyboard walks
      [1, -1].forEach(function (dir) {
        var run2 = 1;
        while (i + run2 < n && lower[i + run2].codePointAt(0) - lower[i + run2 - 1].codePointAt(0) === dir && /[a-z0-9]/.test(lower[i + run2])) run2++;
        for (var l2 = 3; l2 <= run2; l2++) relax(i + l2, base + 4 + Math.log2(l2));
      });
      for (len = 3; i + len <= n; len++) {
        var s2 = lower.slice(i, i + len).join(''), hit = false;
        for (var r = 0; r < KEY_ROWS.length && !hit; r++) {
          var row = KEY_ROWS[r];
          if (row.indexOf(s2) >= 0 || row.split('').reverse().join('').indexOf(s2) >= 0) hit = true;
        }
        if (!hit) break;
        relax(i + len, base + 4 + Math.log2(len));
      }
    }
    var bits = n === 0 ? 0 : cost[n];
    var score = bits < BLOCK_BITS ? 0 : bits < 48 ? 1 : bits < 60 ? 2 : bits < 76 ? 3 : 4;
    return { bits: Math.round(bits * 10) / 10, score: score };
  }
  function normalizeForCommon(pass) {
    var l = String(pass).toLowerCase(), out = {};
    // umlauts as typed on a keyboard without them: ä to ae or a, and so on
    var folded = l.replace(/[äöüß]/g, function (c) { return { 'ä': 'ae', 'ö': 'oe', 'ü': 'ue', 'ß': 'ss' }[c]; });
    var plain = l.replace(/[äöüß]/g, function (c) { return { 'ä': 'a', 'ö': 'o', 'ü': 'u', 'ß': 's' }[c]; });
    // also with every separator and digit taken out: "Ich-Liebe-Dich-123!" is "ichliebedich"
    var lettersOnly = function (s) { return s.replace(/[^a-z]+/g, ''); };
    [l, folded, plain, deleet(l, 'i'), deleet(l, 'l'), deleet(folded, 'i'), lettersOnly(folded), lettersOnly(plain), lettersOnly(deleet(folded, 'i')), lettersOnly(deleet(folded, 'l'))].forEach(function (v) {
      out[v] = true;
      out[v.replace(/[^a-z]+$/, '')] = true; // trailing digits and symbols
    });
    return Object.keys(out);
  }
  // Synchronous rules: returns {ok, code: null|'empty'|'short'|'common'|'weak', n, estimate}. strict: the breach check is
  // not available (service unreachable), so the local estimate has to carry more weight.
  function checkLocal(pass, strict) {
    pass = String(pass || '').normalize('NFC');
    var est = estimate(pass);
    if (pass.length === 0) return { ok: false, code: 'empty', estimate: est };
    var len = Array.from(pass).length;
    if (len < MIN_PASSPHRASE) return { ok: false, code: 'short', n: len, estimate: est };
    if (normalizeForCommon(pass).some(function (v) { return COMMON_SET[v]; })) return { ok: false, code: 'common', estimate: est };
    if (est.bits < BLOCK_BITS) return { ok: false, code: 'weak', estimate: est };
    if (strict && est.bits < STRICT_BITS) return { ok: false, code: 'weak', strict: true, estimate: est };
    return { ok: true, code: null, estimate: est };
  }
  // Breach check: the datastore server answers GET <service>api/v1/pwned/<5 uppercase hex> with the Pwned Passwords range (it asks
  // pwnedpasswords.com itself, so the page only talks to the service). Only the first 5 hex characters of the SHA-1 leave the device.
  // {status: 'ok' | 'pwned' (count) | 'unavailable'}; o.url is the endpoint with a trailing slash.
  async function breachCheck(pass, o) {
    o = o || {};
    var f = o.fetch || (typeof fetch === 'function' ? fetch.bind(root) : null);
    if (!f || !o.url) return { status: 'unavailable' };
    var digest = hexUpper(new Uint8Array(await root.crypto.subtle.digest('SHA-1', utf8(String(pass).normalize('NFC')))));
    var prefix = digest.slice(0, 5), suffix = digest.slice(5);
    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, o.timeoutMs || 8000) : null;
    try {
      var res = await f(o.url + prefix, { method: 'GET', credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store', signal: ctrl ? ctrl.signal : undefined });
      if (!res.ok) return { status: 'unavailable' };
      var lines = (await res.text()).split(/\r?\n/);
      for (var i = 0; i < lines.length; i++) {
        var m = /^([0-9A-Fa-f]{35}):(\d+)/.exec(lines[i].trim());
        if (m && m[1].toUpperCase() === suffix && Number(m[2]) > 0) return { status: 'pwned', count: Number(m[2]) };
      }
      return { status: 'ok' };
    } catch (e) {
      return { status: 'unavailable' };
    } finally { if (timer) clearTimeout(timer); }
  }

  // ------------------------------------------------------------------------------------------------------------
  // 4. Minimal ZIP writer (store only, UTF-8 names) and the export layout
  // ------------------------------------------------------------------------------------------------------------
  var CRC_TABLE = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(bytes) {
    var c = 0xffffffff;
    for (var i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }
  // entries: [{name, data: Uint8Array|string}]. Returns a Blob. No compression, no Zip64 (limits are checked).
  function makeZip(entries, when) {
    var d = when || new Date();
    var dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    var dosDate = (Math.max(0, d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    if (entries.length > 65535) throw new Err.WDSError('too many entries for one ZIP file');
    var parts = [], central = [], offset = 0;
    entries.forEach(function (e) {
      var name = utf8(e.name), data = typeof e.data === 'string' ? utf8(e.data) : e.data;
      if (name.length > 65535 || data.length > 0xfffffffe) throw new Err.WDSError('entry too large for a ZIP file');
      var crc = crc32(data);
      var lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
      lh.setUint16(10, dosTime, true); lh.setUint16(12, dosDate, true); lh.setUint32(14, crc, true);
      lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true); lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
      var ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true);
      ch.setUint16(10, 0, true); ch.setUint16(12, dosTime, true); ch.setUint16(14, dosDate, true); ch.setUint32(16, crc, true);
      ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true); ch.setUint16(28, name.length, true);
      ch.setUint16(30, 0, true); ch.setUint16(32, 0, true); ch.setUint16(34, 0, true); ch.setUint16(36, 0, true);
      ch.setUint32(38, 0, true); ch.setUint32(42, offset, true);
      parts.push(new Uint8Array(lh.buffer), name, data);
      central.push(new Uint8Array(ch.buffer), name);
      offset += 30 + name.length + data.length;
      if (offset > 0xfffffff0) throw new Err.WDSError('archive too large for a ZIP file (4 GiB limit)');
    });
    var cdSize = 0;
    central.forEach(function (c) { cdSize += c.length; });
    var end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(4, 0, true); end.setUint16(6, 0, true);
    end.setUint16(8, entries.length, true); end.setUint16(10, entries.length, true);
    end.setUint32(12, cdSize, true); end.setUint32(16, offset, true); end.setUint16(20, 0, true);
    return new Blob(parts.concat(central, [new Uint8Array(end.buffer)]), { type: 'application/zip' });
  }

  // File name endings for files whose record name has none (the MIME type tells what they are).
  var MIME_EXT = {
    'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp', 'image/avif': '.avif', 'image/svg+xml': '.svg', 'image/bmp': '.bmp',
    'application/pdf': '.pdf', 'application/zip': '.zip', 'application/json': '.json', 'text/plain': '.txt', 'text/csv': '.csv', 'text/html': '.html',
    'text/markdown': '.md', 'audio/mpeg': '.mp3', 'audio/wav': '.wav', 'audio/ogg': '.ogg', 'video/mp4': '.mp4', 'video/webm': '.webm',
  };
  function extForMime(mime) { return MIME_EXT[String(mime || '').split(';')[0].trim().toLowerCase()] || ''; }
  // Path inside the archive for a record: keeps folders, adds ".json" to JSON records and an ending that matches the MIME type
  // to files without one, avoids collisions.
  function archivePaths(records, reserved) {
    var used = {}, out = [];
    (reserved || []).forEach(function (r) { used[r.toLowerCase()] = true; });
    records.forEach(function (r) {
      var p = fileSafe(r.name);
      if (r.kind === 'json' && !/\.json$/i.test(p)) p += '.json';
      else if (r.kind === 'bytes' && !/\.[A-Za-z0-9]{1,8}$/.test(p.slice(p.lastIndexOf('/') + 1))) p += extForMime(r.mime);
      var candidate = p, n = 2;
      while (used[candidate.toLowerCase()]) {
        var dot = p.lastIndexOf('.'), slash = p.lastIndexOf('/');
        candidate = dot > slash + 1 ? p.slice(0, dot) + ' (' + n + ')' + p.slice(dot) : p + ' (' + n + ')';
        n++;
      }
      used[candidate.toLowerCase()] = true;
      out.push(candidate);
    });
    return out;
  }
  function recordBytes(r) {
    if (r.kind === 'json') return utf8(JSON.stringify(r.value, null, 2) + '\n');
    var v = r.value;
    if (v instanceof Uint8Array) return v;
    if (v instanceof ArrayBuffer) return new Uint8Array(v);
    if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
    return utf8(String(v));
  }
  // records: [{name, kind, mime, version, time, value}] -> {blob, manifest}
  function buildArchive(records, meta) {
    var paths = archivePaths(records, ['wds-export.json', 'README.txt']);
    var entries = [], list = [];
    records.forEach(function (r, i) {
      var data = recordBytes(r);
      entries.push({ name: paths[i], data: data });
      list.push({ name: r.name, file: paths[i], kind: r.kind, mime: r.mime || null, version: r.version === undefined ? null : r.version, time: r.time === undefined ? null : r.time, size: data.length });
    });
    var manifest = { format: 'wds-export', v: 1, scope: meta.scope, service: meta.service, exported: meta.exported, note: meta.note || undefined, records: list };
    var readme = 'WIAI Datastore export\r\n\r\nApp (scope): ' + meta.scope + '\r\nExported: ' + meta.exported + '\r\n\r\n' +
      'Every entry of the vault is stored as a file. JSON entries got the ending .json; files without an ending got one that matches their type.\r\n\r\n' +
      'wds-export.json maps each entry name to its file and lists kind, MIME type, version and size.\r\n\r\n' +
      'The files are NOT encrypted: keep them safe.\r\n';
    entries.unshift({ name: 'wds-export.json', data: JSON.stringify(manifest, null, 2) + '\n' }, { name: 'README.txt', data: readme });
    return { blob: makeZip(entries, new Date(meta.exported)), manifest: manifest };
  }

  // ------------------------------------------------------------------------------------------------------------
  // 5. Access sheet (printable HTML)
  // ------------------------------------------------------------------------------------------------------------
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
  // o: {appName, scope, accessId (display), recoveryCode (display)|null, service, created (ms), role}
  function buildSheetHtml(o, t, lang) {
    var rows = [[t('sheet.app'), o.appName + ' (' + o.scope + ')'], [t('sheet.accessId'), o.accessId]];
    if (o.recoveryCode) rows.push([t('sheet.recovery'), o.recoveryCode]);
    if (o.role) rows.push([t('sheet.access'), t('role.' + o.role)]);
    rows.push([t('sheet.created'), formatTime(Math.floor(o.created / 1000), lang)], [t('sheet.service'), o.service]);
    var body = rows.map(function (r, i) {
      var code = (i === 1 || (i === 2 && o.recoveryCode)) ? ' class="code"' : '';
      return '<tr><th scope="row">' + esc(r[0]) + '</th><td' + code + '>' + esc(r[1]) + '</td></tr>';
    }).join('');
    return '<!DOCTYPE html>\n<html lang="' + lang + '"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<title>' + esc(t('sheet.page.title') + ' - ' + o.appName) + '</title><style>' +
      'body{font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;max-width:42rem;margin:2rem auto;padding:0 1rem;color:#111}' +
      'h1{font-size:1.6rem;margin:0 0 .25rem}table{border-collapse:collapse;width:100%;margin:1.25rem 0}' +
      'th,td{text-align:left;padding:.55rem .75rem;border:1px solid #888;vertical-align:top}th{width:11rem;font-weight:600;background:#f2f2f2}' +
      'td.code{font:600 1.35rem/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;letter-spacing:.06em}' +
      '.box{border:1px solid #888;padding:.6rem .9rem;margin:1rem 0;border-radius:4px}.box h2{font-size:1rem;margin:0 0 .25rem}' +
      'button{font:inherit;padding:.4rem .9rem}@media print{.noprint{display:none}body{margin:0}}</style></head><body>' +
      '<h1>' + esc(o.sandbox ? t('sandbox.sheet.title') : t('sheet.page.title')) + '</h1><p>' + esc(o.recoveryCode ? t('sheet.intro.owner') : t('sheet.intro.member')) + '</p>' +
      '<table>' + body + '</table>' +
      '<p>' + esc(t('sheet.passphrase.note')) + '</p>' +
      (o.recoveryCode ? '<p>' + esc(t('sheet.recovery.note')) + '</p>' : '') + (o.sandbox ? '<p>' + esc(t('sandbox.sheet.note')) + '</p>' : '') +
      '<div class="box"><h2>' + esc(t('escrow.title')) + '</h2><p style="margin:0">' + esc(t('escrow.text')) + '</p></div>' +
      '<p class="noprint"><button type="button" onclick="window.print()">' + esc(t('sheet.page.print')) + '</button></p>' +
      '</body></html>\n';
  }

  // ------------------------------------------------------------------------------------------------------------
  // 6. Styles, dialog stack, focus trap, notifications
  // ------------------------------------------------------------------------------------------------------------
  var CSS = [
    '.wds-root{--_bg:var(--wds-bg,#fff);--_fg:var(--wds-fg,#1b1f24);--_muted:var(--wds-muted,#566170);--_border:var(--wds-border,#b9c0ca);',
    '--_accent:var(--wds-accent,#1c58b5);--_accent-fg:var(--wds-accent-fg,#fff);--_danger:var(--wds-danger,#b3261e);--_warn:var(--wds-warn,#8a5a00);',
    '--_ok:var(--wds-ok,#1b6e3c);--_soft:var(--wds-soft,#f1f3f6);--_radius:var(--wds-radius,10px);--_font:var(--wds-font,system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif);',
    '--_mono:var(--wds-mono,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);--_backdrop:var(--wds-backdrop,rgba(15,20,30,.55));',
    '--_shadow:var(--wds-shadow,0 18px 50px rgba(0,0,0,.35));font-family:var(--_font);font-size:var(--wds-font-size,16px);line-height:1.5;color:var(--_fg)}',
    '@media (prefers-color-scheme:dark){.wds-root{--_bg:var(--wds-bg,#1d2128);--_fg:var(--wds-fg,#e9ecf0);--_muted:var(--wds-muted,#a5afbc);',
    '--_border:var(--wds-border,#434c59);--_accent:var(--wds-accent,#7db0ff);--_accent-fg:var(--wds-accent-fg,#0a1a33);--_danger:var(--wds-danger,#ff9a90);',
    '--_warn:var(--wds-warn,#f0c36a);--_ok:var(--wds-ok,#78d9a0);--_soft:var(--wds-soft,#272d36)}}.wds-root *,.wds-root *::before,.wds-root *::after{box-sizing:border-box}',
    // The dialog is a modal <dialog> (top layer). App CSS for "dialog" (padding, max-width, border, centring with transform, fade-in with
    // opacity, display:flex ...) must not change the box: "all:initial" plus the explicit box below, the critical properties with !important.
    '.wds-root.wds-dialog{all:initial;display:block!important;position:fixed!important;inset:0 0 auto 0!important;',
    'margin:max(1rem,6vh) auto 1rem!important;padding:0!important;border:0!important;transform:none!important;translate:none!important;',
    'opacity:1!important;visibility:visible!important;animation:none!important;transition:none!important;',
    'width:min(34rem,calc(100vw - 2rem))!important;max-width:none!important;min-width:0!important;height:auto!important;min-height:0!important;',
    'max-height:calc(100vh - 2rem)!important;max-height:calc(100dvh - 2rem)!important;',
    'overflow:auto!important;overscroll-behavior:contain;box-sizing:border-box;font-family:var(--_font);font-size:var(--wds-font-size,16px);line-height:1.5;',
    'color:var(--_fg);background:var(--_bg);border-radius:var(--_radius);box-shadow:var(--_shadow);outline:0}.wds-root.wds-dialog:not([open]){display:none!important}',
    '.wds-root.wds-dialog.wds-dialog-wide{width:min(46rem,calc(100vw - 2rem))!important}',
    '.wds-root.wds-dialog::backdrop{background:var(--_backdrop,rgba(15,20,30,.55))!important;opacity:1!important;visibility:visible!important;display:block!important}',
    '.wds-head{display:flex;align-items:flex-start;justify-content:space-between;gap:1rem;padding:1.15rem 1.4rem .3rem}.wds-title{margin:0;font-size:1.25rem;line-height:1.3;font-weight:650;color:inherit}',
    '.wds-sub{margin:.15rem 0 0;color:var(--_muted);font-size:.9rem}.wds-body{padding:.5rem 1.4rem 1.4rem}.wds-body p{margin:.6rem 0}',
    '.wds-x{font:inherit;line-height:1;background:none;border:0;color:var(--_muted);font-size:1.6rem;padding:.1rem .4rem;cursor:pointer;border-radius:6px}.wds-field{margin:.95rem 0}',
    '.wds-label{display:block;font-weight:600;margin:0 0 .25rem}.wds-hint{color:var(--_muted);font-size:.875rem;margin:.3rem 0 0}',
    '.wds-input,.wds-select{display:block;width:100%;padding:.55rem .65rem;border:1px solid var(--_border);border-radius:calc(var(--_radius) - 4px);background:var(--_bg);color:inherit;font:inherit}',
    '.wds-mono{font-family:var(--_mono);letter-spacing:.05em}',
    // Host pages often style bare input and label elements (width:100%, min-height, display:block); the rows of the dialogs must not
    // depend on that, so these rules are specific enough to win and reset what such global rules set.
    '.wds-root .wds-check{display:flex;gap:.55rem;align-items:flex-start;margin:.5rem 0}',
    '.wds-root .wds-check input[type=checkbox]{-webkit-appearance:checkbox;appearance:auto;box-sizing:border-box;flex:none;width:1.1rem;height:1.1rem;min-width:0;min-height:0;max-width:none;padding:0;margin:.2rem 0 0;border:revert;background:revert}',
    '.wds-root .wds-check label{display:block;flex:1 1 auto;min-width:0;margin:0;padding:0;font:inherit;font-weight:400;line-height:inherit;color:inherit;text-transform:none;letter-spacing:normal}',
    '.wds-btn{font:inherit;padding:.55rem 1rem;border:1px solid var(--_border);background:var(--_soft);color:inherit;border-radius:calc(var(--_radius) - 4px);cursor:pointer;display:inline-block;text-decoration:none;line-height:1.3}',
    '.wds-btn:hover{border-color:var(--_accent)}.wds-btn-primary{background:var(--_accent);color:var(--_accent-fg);border-color:var(--_accent);font-weight:600}',
    '.wds-btn-danger{background:var(--_danger);color:var(--_bg);border-color:var(--_danger);font-weight:600}.wds-btn-small{padding:.3rem .65rem;font-size:.875rem}',
    '.wds-btn[disabled],.wds-input[disabled],.wds-select[disabled]{opacity:.55;cursor:not-allowed}',
    '.wds-link{font:inherit;background:none;border:0;padding:0;color:var(--_accent);text-decoration:underline;cursor:pointer}.wds-actions{display:flex;flex-wrap:wrap;align-items:center;gap:.6rem;margin-top:1.15rem}',
    '.wds-spacer{flex:1 1 auto}.wds-root :focus-visible{outline:3px solid var(--_accent);outline-offset:2px}',
    '.wds-vh{position:absolute!important;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0;padding:0;margin:-1px}',
    '.wds-btn:focus-within{outline:3px solid var(--_accent);outline-offset:2px}',
    '.wds-msg{margin:.8rem 0;padding:.6rem .8rem;border-left:4px solid var(--_accent);background:var(--_soft);border-radius:0 calc(var(--_radius) - 4px) calc(var(--_radius) - 4px) 0}',
    '.wds-msg-error{border-left-color:var(--_danger)}.wds-msg-warn{border-left-color:var(--_warn)}.wds-msg-ok{border-left-color:var(--_ok)}.wds-error{color:var(--_danger);font-weight:600;margin:.5rem 0 0}',
    '.wds-meter{height:.4rem;background:var(--_soft);border:1px solid var(--_border);border-radius:99px;overflow:hidden;margin-top:.5rem}',
    '.wds-meter-bar{height:100%;width:0;background:var(--_danger);transition:width .15s}',
    '.wds-meter-bar[data-level="2"]{background:var(--_warn)}.wds-meter-bar[data-level="3"],.wds-meter-bar[data-level="4"]{background:var(--_ok)}.wds-strength{margin:.3rem 0 0;font-size:.875rem;color:var(--_muted)}',
    // the line keeps its height while it is empty: the label appears 120 ms after typing, and a button below must not move away from under a click
    '.wds-strength:empty::before{content:"\\200b"}.wds-box{border:1px solid var(--_border);border-radius:calc(var(--_radius) - 2px);padding:.7rem .9rem;margin:1rem 0;background:var(--_soft)}',
    '.wds-box h3{margin:0 0 .25rem;font-size:1rem}.wds-box p{margin:.25rem 0}',
    '.wds-code{font:600 1rem/1.5 var(--_mono);letter-spacing:.04em;padding:.55rem .75rem;border:1px solid var(--_border);border-radius:calc(var(--_radius) - 4px);background:var(--_soft);white-space:nowrap;overflow-x:auto;user-select:all}',
    '.wds-g{display:inline-block}.wds-body>.wds-section:first-child{border-top:0;margin-top:.2rem;padding-top:0}',
    '.wds-dl{display:grid;grid-template-columns:max-content 1fr;gap:.45rem .9rem;margin:1rem 0}.wds-dl dt{font-weight:600}.wds-dl dd{margin:0;min-width:0}',
    '.wds-section{border-top:1px solid var(--_border);margin-top:1.4rem;padding-top:1rem}.wds-section>h3{margin:0 0 .4rem;font-size:1.05rem}.wds-people{list-style:none;margin:.4rem 0;padding:0}',
    '.wds-person{display:flex;flex-wrap:wrap;gap:.5rem .9rem;align-items:center;border:1px solid var(--_border);border-radius:calc(var(--_radius) - 2px);padding:.65rem .8rem;margin:.5rem 0}',
    '.wds-person-main{flex:1 1 13rem;min-width:0}.wds-person-name{font-weight:600}.wds-person-info{color:var(--_muted);font-size:.875rem}',
    '.wds-badge{display:inline-block;font-size:.75rem;font-weight:500;padding:.05rem .5rem;margin-left:.4rem;border-radius:99px;border:1px solid var(--_border);background:var(--_soft);color:var(--_muted);vertical-align:.1em}',
    '.wds-compare{display:grid;grid-template-columns:1fr 1fr;gap:.8rem;margin:1rem 0}',
    '@media (max-width:36rem){.wds-compare{grid-template-columns:1fr}.wds-dl{grid-template-columns:1fr}.wds-code{font-size:.875rem;letter-spacing:.02em}}',
    '@media (max-width:24rem){.wds-code{white-space:normal;overflow-wrap:anywhere;font-size:.8125rem}}',
    '.wds-pane{border:1px solid var(--_border);border-radius:calc(var(--_radius) - 2px);padding:.65rem .75rem;min-width:0}.wds-pane h3{margin:0;font-size:1rem}.wds-pane .wds-sub{margin:0 0 .3rem}',
    '.wds-pre{margin:.4rem 0 0;padding:.5rem;max-height:13rem;overflow:auto;font:.8125rem/1.45 var(--_mono);white-space:pre-wrap;word-break:break-word;background:var(--_soft);border-radius:6px}',
    '.wds-progress{width:100%;height:1rem;margin:.6rem 0}',
    '.wds-spin{display:inline-block;width:1em;height:1em;border:2px solid var(--_border);border-top-color:var(--_accent);border-radius:50%;animation:wds-rot .8s linear infinite;vertical-align:-.15em;margin-right:.45rem}',
    '@keyframes wds-rot{to{transform:rotate(360deg)}}@media (prefers-reduced-motion:reduce){.wds-spin{animation:none}.wds-meter-bar{transition:none}}.wds-fs{border:0;margin:0;padding:0;min-width:0}',
    '.wds-details{margin:.9rem 0}.wds-details>summary{cursor:pointer;font-weight:600}',
    // Notices: status lines at the top centre, a popover="manual" (top layer) that never takes a click; the library shows it again above every new dialog.
    '.wds-notices{position:fixed;inset:.75rem auto auto 50%;transform:translateX(-50%);z-index:2147483001;display:flex;flex-direction:column;gap:.4rem;width:min(34rem,calc(100vw - 1.5rem));height:auto;margin:0;padding:0;border:0;background:transparent;overflow:visible;pointer-events:none}',
    '.wds-notice{margin:0;pointer-events:none;background:var(--_bg);color:var(--_fg);border:1px solid var(--_border);border-left:5px solid var(--_accent);border-radius:calc(var(--_radius) - 2px);padding:.5rem .8rem;font-size:.9rem;box-shadow:var(--_shadow)}',
    '.wds-act{margin:.7rem 0}.wds-act .wds-hint{margin-top:.3rem}',
  ].join('');

  function ensureStyle() {
    if (document.getElementById('wds-style')) return;
    var st = document.createElement('style');
    st.id = 'wds-style';
    st.textContent = CSS;
    (document.head || document.documentElement).appendChild(st);
  }

  var stack = [];
  var restoreFocusTo = null;
  var overlays = [];                      // popovers (notices, sandbox badge): shown again above every new modal dialog
  var layerListening = false;
  var HAS_POPOVER = typeof HTMLElement !== 'undefined' && typeof HTMLElement.prototype.showPopover === 'function';

  var FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),summary,[tabindex]:not([tabindex="-1"])';
  function focusables(node) {
    return Array.prototype.filter.call(node.querySelectorAll(FOCUSABLE), function (n) {
      return !n.hasAttribute('inert') && (n.offsetWidth > 0 || n.offsetHeight > 0 || n.getClientRects().length > 0);
    });
  }

  // ---- the top layer: library dialogs are modal <dialog>s; notices and the sandbox badge are popovers that are kept above them ----
  // The browser does stacking: the newest showModal() is on top. A popover="manual" shown after a modal dialog is inert unless it lies
  // inside that dialog, which does not matter here: notices and the badge never take a click (pointer-events: none).
  function isLibDialog(n) { return !!(n && n.classList && n.classList.contains('wds-dialog')); }
  function foreignModals() {   // the app's own dialogs that are open with showModal()
    var out = [];
    try { Array.prototype.forEach.call(document.querySelectorAll('dialog:modal'), function (n) { if (!isLibDialog(n)) out.push(n); }); } catch (e) { /* :modal not supported */ }
    return out;
  }
  function popoverOpen(n) { try { return n.matches(':popover-open'); } catch (e) { return false; } }
  function showPop(n) {
    if (!HAS_POPOVER || !n || !n.hasAttribute('popover') || !n.isConnected) return;
    try { if (popoverOpen(n)) n.hidePopover(); n.showPopover(); } catch (e) { /* cannot be shown right now */ }
  }
  function hidePop(n) { if (HAS_POPOVER && n && n.hasAttribute('popover') && popoverOpen(n)) { try { n.hidePopover(); } catch (e) { /* ignore */ } } }
  function raiseOverlays() { overlays.forEach(showPop); }
  // The browser or an app sweep closed a library dialog, or a re-render of the page removed it: show it again (the newest on top).
  function raiseDialogs() {
    stack.slice().forEach(function (d) {
      if (d.closed) return;
      try {
        if (!d.dialog.isConnected) document.body.appendChild(d.dialog);
        if (d.dialog.open) d.dialog.close();
        d.dialog.showModal();
      } catch (e) { /* ignore */ }
    });
    var top = stack[stack.length - 1];
    if (top && !top.closed) top.refocus();
  }

  // fresh: a dialog of the app has just been opened (it is above ours, whatever the element is): ours goes on top again.
  function syncLayers(fresh) {
    var raise = fresh === true && foreignModals().length > 0;
    stack.forEach(function (d) { if (!d.closed && !d.dialog.isConnected) raise = true; });
    if (stack.length && raise) raiseDialogs();
    if (raise) raiseOverlays();
  }
  function onLayerFocusIn(ev) {
    if (ev.target && ev.target.closest && ev.target.closest('.wds-root')) return;
    syncLayers();
  }
  function onLayerClose() { syncLayers(); }   // 'close' does not bubble but reaches a capture listener
  function onLayerKey(ev) {
    if (ev.key !== 'Escape' || ev.isComposing || !stack.length) return;
    var top = stack[stack.length - 1];
    ev.preventDefault(); ev.stopPropagation();    // preventDefault on keydown stops the browser's own cancel/close; the library decides
    if (top.cancelable) top.close(undefined);
  }
  function ensureLayerListeners() {
    if (layerListening || typeof document === 'undefined') return;
    layerListening = true;
    document.addEventListener('focusin', onLayerFocusIn, true);
    document.addEventListener('close', onLayerClose, true);
    document.addEventListener('keydown', onLayerKey, true);
    if (typeof MutationObserver === 'function') {   // a dialog of the app that gets its "open" attribute: showModal() or show(), also on an element that was open before
      try {
        new MutationObserver(function (recs) {
          for (var i = 0; i < recs.length; i++) { var n = recs[i].target; if (n && n.localName === 'dialog' && !isLibDialog(n) && n.hasAttribute('open')) { syncLayers(true); return; } }
        }).observe(document.documentElement, { attributes: true, attributeFilter: ['open'], subtree: true });
      } catch (e) { /* no observer: the focus events still notice */ }
      try { new MutationObserver(function () { syncLayers(); }).observe(document.body, { childList: true }); } catch (e) { /* ignore */ }   // a page that re-renders its body and removes a dialog
    }
  }
  function closeAllDialogs() {
    stack.slice().reverse().forEach(function (d) { d.close(undefined); });
  }

  // The banner of a sandbox scope: inline !important styles, so that CSS of the host page cannot hide it.
  function pinVisible(node, extra) {
    node.style.setProperty('display', 'block', 'important');
    node.style.setProperty('visibility', 'visible', 'important');
    node.style.setProperty('opacity', '1', 'important');
    if (extra) Object.keys(extra).forEach(function (k) { node.style.setProperty(k, extra[k], 'important'); });
    return node;
  }
  function sandboxBanner(S) {
    var sb = S.info && S.info.sandbox;
    return pinVisible(el('div', { class: 'wds-msg wds-msg-warn', role: 'note', 'data-wds': 'sandbox-banner', text: S.t('sandbox.banner', { time: formatTime(sb.next_wipe, S.lang) }) }),
      { margin: '0', 'border-radius': '10px 10px 0 0', padding: '.55rem 1.4rem', 'font-size': '.9rem', 'background-color': '#fff4cc', color: '#3d2b00', 'border-left': '0', 'border-bottom': '2px solid #b58100' });
  }
  function isSandbox(S) { return !!(S.info && S.info.sandbox); }
  // In a sandbox a small badge sits in the bottom-left corner of the page (it takes no click); every dialog also has the "Sandbox" title prefix.
  var sandboxBadge = null;
  function showSandboxBadge(S) {
    if (sandboxBadge && sandboxBadge.isConnected) return;
    ensureStyle();
    ensureLayerListeners();
    sandboxBadge = pinVisible(el('div', { class: 'wds-root', role: 'note', lang: S.lang, 'data-wds': 'sandbox-badge', text: S.t('sandbox.bar'), popover: HAS_POPOVER ? 'manual' : null }), {
      position: 'fixed', left: '0', bottom: '0', top: 'auto', right: 'auto', margin: '0', width: 'auto', height: 'auto', overflow: 'visible', border: '0', 'z-index': '2147483001',
      padding: '.15rem .6rem', 'font-size': '.75rem', 'line-height': '1.4', 'font-weight': '600', 'background-color': '#fff4cc', color: '#3d2b00', 'border-top': '2px solid #b58100', 'border-right': '2px solid #b58100',
      'border-radius': '0 6px 0 0', 'pointer-events': 'none',
    });
    document.body.appendChild(sandboxBadge);
    overlays.push(sandboxBadge); showPop(sandboxBadge);
  }
  // Many apps share the one sandbox scope: its name alone does not say which app is being tested. In a sandbox the page title
  // (trimmed, at most 60 characters) comes first, then the scope name; elsewhere the scope name is the app.
  function pageTitle() {
    var s = String((typeof document !== 'undefined' && document.title) || '').replace(/\s+/g, ' ').trim();
    return s.length > 60 ? s.slice(0, 59).trim() + '…' : s;
  }
  function appLabel(S, name) {
    var pt = isSandbox(S) ? pageTitle() : '';
    return pt && pt !== name ? pt + ' – ' + name : name;
  }
  function sandboxPrefix(S) { return isSandbox(S) ? S.t('sandbox.prefix') : ''; }
  // Opens a library dialog for this store: language, and in a sandbox the title prefix and the banner.
  function dialogFor(S, o) {
    o.lang = S.lang;
    if (isSandbox(S)) { o.titlePrefix = sandboxPrefix(S); o.banner = sandboxBanner(S); }
    return openDialog(o);
  }

  // o: {title, view, cancelable, wide, role, sandbox (scope info of a sandbox: title prefix + banner), onClose(result)}. Returns the dialog handle.
  // Every dialog is a modal <dialog class="wds-root wds-dialog"> with data-wds-view (its current view, see setView: set when the view is rendered)
  // and aria-busy="true" while it waits (loading, progress, a submit in flight); in a sandbox it carries the banner.
  function openDialog(o) {
    ensureStyle();
    ensureLayerListeners();
    var titleId = uid('wds-title');
    var dialog = el('dialog', { class: 'wds-root wds-dialog' + (o.wide ? ' wds-dialog-wide' : ''), lang: o.lang, role: o.role === 'alertdialog' ? 'alertdialog' : null, 'aria-labelledby': titleId, tabindex: '-1', 'data-wds-view': o.view || 'loading' });   // a dialog is never without a view
    var prefix = o.titlePrefix || '', rawTitle = o.title || '', bareTitle = false;
    var title = el('h2', { class: 'wds-title', id: titleId, text: prefix + rawTitle });
    var body = el('div', { class: 'wds-body' });
    var d = { dialog: dialog, body: body, title: title, closed: false, cancelable: !!o.cancelable, lastFocused: null };
    var closeBtn = o.cancelable ? el('button', { type: 'button', class: 'wds-x', 'aria-label': o.closeLabel || 'Close', 'data-wds': 'close', onclick: function () { d.close(undefined); } }, '×') : null;
    append(dialog, [o.banner || null, el('div', { class: 'wds-head' }, [title, closeBtn]), body]);
    if (!o.view || o.view === 'loading' || o.view === 'progress') dialog.setAttribute('aria-busy', 'true');
    // The library decides about closing: the browser's own cancel (Escape without a keydown we saw, a close watcher) is refused.
    dialog.addEventListener('cancel', function (ev) { ev.preventDefault(); });
    // The browser closed it anyway (form method=dialog, an app sweep over all dialogs): a mandatory dialog never vanishes, a cancelable one is cancelled.
    dialog.addEventListener('close', function () {
      if (d.closed || dialog.open) return;
      if (d.cancelable) { d.close(undefined); return; }
      try { if (!dialog.isConnected) document.body.appendChild(dialog); dialog.showModal(); } catch (e) { /* ignore */ }
    });
    dialog.addEventListener('focusin', function (ev) { d.lastFocused = ev.target; });
    function paintTitle() { title.textContent = (bareTitle ? '' : prefix) + rawTitle; }
    d.setTitle = function (s, bare) { rawTitle = s; bareTitle = !!bare; paintTitle(); };
    // The scope turned out to be a sandbox after the dialog was opened (the first view loads the scope information).
    d.applySandbox = function (S) {
      if (!isSandbox(S)) return;
      prefix = sandboxPrefix(S); paintTitle();
      var old = dialog.querySelector('[data-wds="sandbox-banner"]');
      if (old) old.parentNode.removeChild(old);
      dialog.insertBefore(sandboxBanner(S), dialog.firstChild);
    };
    d.setView = function (v) {
      v = v || 'loading';   // never an empty view: a dialog that is being built is "loading" (and busy)
      dialog.setAttribute('data-wds-view', v);
      if (v === 'loading' || v === 'progress') dialog.setAttribute('aria-busy', 'true'); else dialog.removeAttribute('aria-busy');
      if (!dialog.contains(document.activeElement)) dialog.focus();   // a view without a control: keep the focus (and Escape) in the dialog
    };
    d.setBusy = function (on) { if (on) dialog.setAttribute('aria-busy', 'true'); else dialog.removeAttribute('aria-busy'); };
    d.setCancelable = function (on) { d.cancelable = !!on; if (closeBtn) closeBtn.disabled = !on; };
    d.focusFirst = function () {
      var f = focusables(body);
      (f[0] || dialog).focus();
    };
    d.refocus = function () {
      var last = d.lastFocused;
      if (last && last.isConnected && dialog.contains(last) && last.focus) { try { last.focus(); return; } catch (e) { /* fall through */ } }
      d.focusFirst();
    };
    d.close = function (result) {
      if (d.closed) return;
      d.closed = true;
      var idx = stack.indexOf(d);
      if (idx >= 0) stack.splice(idx, 1);
      try { if (dialog.open) dialog.close(); } catch (e) { /* ignore */ }
      if (dialog.parentNode) dialog.parentNode.removeChild(dialog);
      var top = stack[stack.length - 1];
      if (top) { if (!top.dialog.contains(document.activeElement)) top.refocus(); }
      else {
        var back = restoreFocusTo;
        restoreFocusTo = null;
        if (back && back.focus && document.contains(back)) { try { back.focus(); } catch (e) { /* ignore */ } }
      }
      syncLayers();
      if (o.onClose) o.onClose(result);
    };
    if (!stack.length) restoreFocusTo = document.activeElement;
    stack.push(d);
    document.body.appendChild(dialog);
    if (typeof dialog.showModal === 'function') { try { dialog.showModal(); } catch (e) { dialog.setAttribute('open', ''); } } else dialog.setAttribute('open', '');
    syncLayers();
    raiseOverlays();
    dialog.focus();
    return d;
  }

  // ---- notices: status lines at the top centre, no buttons, gone after a few seconds ----
  // Anything that needs an answer is a dialog. The region is a popover (top layer) with pointer-events: none, so it never covers a click target.
  var NOTICE_MS = 6000, noticeEl = null, noticeLines = {}, noticeSeq = 0;
  function showNotice(o) {   // o: { text, key?, lang, label }; a notice with a key that is showing is updated in place
    ensureStyle();
    ensureLayerListeners();
    if (!noticeEl) {
      noticeEl = el('div', { class: 'wds-root wds-notices', role: 'status', 'aria-live': 'polite', 'aria-label': o.label, 'data-wds': 'notices', popover: HAS_POPOVER ? 'manual' : null });
      overlays.push(noticeEl);
    }
    if (!noticeEl.isConnected) document.body.appendChild(noticeEl);
    var key = o.key || 'n' + (++noticeSeq), line = noticeLines[key];
    if (!line) { line = noticeLines[key] = { node: el('p', { class: 'wds-notice', 'data-wds-notice': o.key || null }), timer: null }; noticeEl.appendChild(line.node); }
    line.node.setAttribute('lang', o.lang); line.node.textContent = o.text;
    clearTimeout(line.timer);
    line.timer = setTimeout(function () {
      if (line.node.parentNode) line.node.parentNode.removeChild(line.node);
      if (noticeLines[key] === line) delete noticeLines[key];
      if (!noticeEl.firstChild) hidePop(noticeEl);
    }, NOTICE_MS);
    showPop(noticeEl);
  }

  // ------------------------------------------------------------------------------------------------------------
  // 7. Form building blocks and error texts
  // ------------------------------------------------------------------------------------------------------------
  function inp(o) {
    return el('input', {
      id: o.id, type: o.type || 'text', class: 'wds-input' + (o.mono ? ' wds-mono' : ''), value: o.value, autocomplete: o.autocomplete || 'off',
      autocapitalize: o.autocapitalize || 'off', autocorrect: 'off', spellcheck: 'false', name: o.name, maxlength: o.maxlength, accept: o.accept,
      'aria-label': o.ariaLabel, 'data-wds': o.wds,
    });
  }
  // A labelled field with hint and error slot. Returns {wrap, input, setError, clearError}.
  function field(o) {
    var id = o.input.id || uid('wds-in');
    o.input.id = id;
    var hintId = id + '-hint', errId = id + '-err';
    var describedBy = [];
    var hint = o.hint ? el('p', { class: 'wds-hint', id: hintId, text: o.hint }) : null;
    if (hint) describedBy.push(hintId);
    var err = el('div', { class: 'wds-error', id: errId, role: 'alert' });
    describedBy.push(errId);
    o.input.setAttribute('aria-describedby', describedBy.join(' '));
    var wrap = el('div', { class: 'wds-field' }, [el('label', { class: 'wds-label', for: id, text: o.label }), o.input, hint, err]);
    return {
      wrap: wrap, input: o.input,
      setError: function (s) { err.textContent = s; o.input.setAttribute('aria-invalid', 'true'); },
      clearError: function () { err.textContent = ''; o.input.removeAttribute('aria-invalid'); },
    };
  }
  function msg(kind, text, role) { return el('div', { class: 'wds-msg wds-msg-' + kind, role: role || (kind === 'error' ? 'alert' : 'status') }, text); }
  // A code in groups ("XXXX-XXXX-..."): each group is one unit, so lines wrap between groups.
  function codeBox(text, attrs) {
    var groups = String(text).split('-');
    var box = el('div', Object.assign({ class: 'wds-code' }, attrs));
    groups.forEach(function (g, i) { box.appendChild(el('span', { class: 'wds-g', text: g + (i < groups.length - 1 ? '-' : '') })); });
    return box;
  }
  // o.wds: the stable name of the control (attribute data-wds). Every control inside .wds-root has one (PLAN: wds-verify and
  // app tests click library controls by it, in any language).
  function btn(label, o) {
    o = o || {};
    return el('button', { type: o.type || 'button', class: 'wds-btn' + (o.primary ? ' wds-btn-primary' : '') + (o.danger ? ' wds-btn-danger' : '') + (o.small ? ' wds-btn-small' : ''), onclick: o.onClick, disabled: o.disabled, 'data-wds': o.wds }, label);
  }
  function linkBtn(label, onClick, wds) { return el('button', { type: 'button', class: 'wds-link', onclick: onClick, 'data-wds': wds }, label); }
  // A dialog that cannot go on (a request failed, a view could not be built): the "error" view with the reason and a retry. A dialog always ends
  // in a view that a person (or a test) can act on, never in a loading view that nothing will finish.
  // An error that is not one of the library's own (a view that could not be built) shows a fixed sentence, not the exception text, which is
  // for the console.
  function showErrorView(S, dlg, title, e, where, retry) {
    var text;
    try { text = e instanceof Err.WDSError ? explainError(S, e, where) : S.t('err.build'); } catch (e2) { text = S.t('err.build'); }
    clear(dlg.body); dlg.setTitle(title);
    append(dlg.body, [
      el('div', { 'data-wds': 'form-error', 'aria-live': 'polite' }, msg('error', text)),
      el('div', { class: 'wds-actions' }, [btn(S.t('common.retry'), { primary: true, wds: 'retry', onClick: retry })]),
    ]);
    dlg.setView('error');
    dlg.focusFirst();
  }
  function busyLine() { return el('p', { class: 'wds-hint', role: 'status', 'aria-live': 'polite' }); }
  function showBusy(line, text) { clear(line); if (text) append(line, [el('span', { class: 'wds-spin', 'aria-hidden': 'true' }), text]); }

  function explainError(S, e, where) {
    var t = S.t;
    if (e instanceof Err.OfflineError) return t('err.offline');
    if (e instanceof Err.VersionError) return t('note.version', { message: e.message });
    if (e instanceof Err.IntegrityError) return e.code === 'rollback' ? t('err.rollback') : t('err.integrity', { code: e.code || 'integrity' });
    if (e instanceof Err.AuthError) {
      if (e.code === 'revoked') return t('err.revoked');
      if (e.code === 'vault_deleted') return t('err.vaultDeleted');
      if (e.code === 'invite_expired' || e.status === 410) return t('err.expired');
      return where === 'redeem' ? t('err.invite.invalid') : t('err.wrongPass');
    }
    if (e && (e.status === 429 || e.code === 'rate_limited')) return t('err.rate');
    if (e && e.code === 'already_redeemed') return t('err.alreadyRedeemed');
    if (e && e.code === 'join_code_invalid') return t('err.joinCode');
    var nightly = S.info && S.info.sandbox ? ' ' + t('sandbox.nightly') : '';
    if (e && e.code === 'sandbox_disabled') return t('err.sandboxDisabled') + nightly;
    if (e && e.code === 'vault_limit_reached') return t('err.vaultLimit') + nightly;
    if (e && e.code === 'scope_suspended') return t('create.suspended');
    if (e && e.status === 404) return where === 'scope' ? t('err.scope') : t('err.notFound');
    if (e && e.status === 400 && where === 'unlock') return t('err.badId');
    if (e && e.code === 'invalid_code') return where === 'redeem' ? t('err.invite.invalid') : t('err.badId');
    if (e && /no escrow key IDs are pinned/.test(e.message || '')) return t('err.noPins');
    return t('err.generic', { message: (e && e.message) || String(e) });
  }

  // Passphrase input(s) with strength meter, rule checks and the breach check. mode: 'new' (rules, repeat field) or 'current'.
  function passphraseGroup(S, o) {
    var t = S.t, isNew = o.mode === 'new';
    var pw = inp({ type: 'password', mono: false, autocomplete: isNew ? 'new-password' : 'current-password', wds: 'passphrase' });
    var f1 = field({ label: o.label || t('create.passphrase'), input: pw, hint: isNew ? (o.hint === undefined ? t('create.passphrase.hint') : o.hint) : null });
    var rep = null, f2 = null, meterWrap = null, bar = null, strengthLine = null, timer = null;
    var nodes = [f1.wrap];
    if (isNew) {
      bar = el('div', { class: 'wds-meter-bar', 'data-level': '0' });
      meterWrap = el('div', { class: 'wds-meter', 'aria-hidden': 'true' }, bar);
      strengthLine = el('p', { class: 'wds-strength', role: 'status', 'aria-live': 'polite' });
      f1.wrap.insertBefore(meterWrap, f1.wrap.querySelector('.wds-error'));
      f1.wrap.insertBefore(strengthLine, f1.wrap.querySelector('.wds-error'));
      rep = inp({ type: 'password', autocomplete: 'new-password', wds: 'passphrase-repeat' });
      f2 = field({ label: t('create.repeat'), input: rep });
      nodes.push(f2.wrap);
    }
    var showId = uid('wds-show');
    var show = el('input', { type: 'checkbox', id: showId, 'data-wds': 'show-passphrase', onchange: function () {
      var type = show.checked ? 'text' : 'password';
      pw.type = type;
      if (rep) rep.type = type;
    } });
    nodes.push(el('div', { class: 'wds-check' }, [show, el('label', { for: showId, text: t('pw.show') })]));
    var hibpLine = el('p', { class: 'wds-hint', role: 'status', 'aria-live': 'polite' });
    if (isNew) nodes.push(hibpLine);
    function updateStrength() {
      if (!isNew) return;
      var v = pw.value;
      if (!v) { bar.style.width = '0%'; strengthLine.textContent = ''; return; }
      var est = estimate(v.normalize('NFC'));
      bar.style.width = (12 + est.score * 22) + '%';
      bar.setAttribute('data-level', String(est.score));
      strengthLine.textContent = t('pw.strength', { label: t('pw.label.' + est.score) });
    }
    if (isNew) pw.addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(updateStrength, 120); f1.clearError(); });
    if (rep) rep.addEventListener('input', function () { f2.clearError(); });
    pw.addEventListener('input', function () { f1.clearError(); });
    var g = {
      nodes: nodes, input: pw,
      value: function () { return pw.value; },
      focus: function () { pw.focus(); },
      // 'current': only checks for emptiness. 'new': full rules. Returns {passphrase, hibp} or null (error shown).
      validate: async function () {
        var v = pw.value;
        if (!isNew) {
          if (!v) { f1.setError(t('err.passphrase.missing')); pw.focus(); return null; }
          return { passphrase: v };
        }
        var local = checkLocal(v);
        if (!local.ok) {
          var key = local.code === 'empty' ? 'pw.empty' : local.code === 'short' ? 'pw.tooShort' : local.code === 'common' ? 'pw.common' : 'pw.weak';
          f1.setError(t(key, { n: local.n })); pw.focus(); updateStrength(); return null;
        }
        if (rep.value !== v) { f2.setError(t('pw.mismatch')); rep.focus(); return null; }
        showBusy(hibpLine, t('pw.hibp.checking'));
        var hibp = await breachCheck(v, { url: S.client.apiBase + '/pwned/' });
        showBusy(hibpLine, '');
        if (hibp.status === 'pwned') { f1.setError(t('pw.pwned', { count: hibp.count })); pw.focus(); return null; }
        if (hibp.status === 'unavailable') hibpLine.textContent = t('pw.hibp.unavailable');
        // Without the breach check a well-known passphrase would pass unseen, so the local estimate has to be stricter.
        if (hibp.status !== 'ok' && !checkLocal(v, true).ok) { hibpLine.textContent = ''; f1.setError(t('pw.weak.noBreachCheck')); pw.focus(); updateStrength(); return null; }
        return { passphrase: v, hibp: hibp };
      },
      reset: function () { pw.value = ''; if (rep) rep.value = ''; },
      note: function () { return el('p', { class: 'wds-hint', text: t('pw.hibp.note') }); },
    };
    return g;
  }

  // ------------------------------------------------------------------------------------------------------------
  // 8. Unlock flow: unlock, create vault, redeem invite, access sheet
  // ------------------------------------------------------------------------------------------------------------
  function printHtml(host, html) {
    var f = document.createElement('iframe');
    f.setAttribute('aria-hidden', 'true'); f.setAttribute('tabindex', '-1'); f.setAttribute('title', 'print');
    f.style.cssText = 'position:fixed;width:0;height:0;border:0;right:0;bottom:0';
    f.onload = function () {
      try { f.contentWindow.focus(); f.contentWindow.print(); } catch (e) { /* printing blocked */ }
      setTimeout(function () { if (f.parentNode) f.parentNode.removeChild(f); }, 60000);
    };
    f.srcdoc = html;
    (host || document.body).appendChild(f);
  }

  function sheetView(S, dlg, o, onContinue) {
    var t = S.t, sandbox = isSandbox(S);
    clear(dlg.body); dlg.setView('sheet');
    if (sandbox) dlg.setTitle(t('sandbox.sheet.title'), true); else dlg.setTitle(t('sheet.title'));
    var owner = !!o.recoveryCode && !sandbox;   // a sandbox vault has no recovery: the code is neither shown nor kept
    var data = { appName: o.appName, scope: S.client.scope, accessId: o.accessId, recoveryCode: owner ? o.recoveryCode : null, service: S.client.service, created: S.now(), role: o.role, sandbox: sandbox };
    var dl = el('dl', { class: 'wds-dl' }, [
      el('dt', { text: t('sheet.app') }), el('dd', { text: o.appName }),
      el('dt', { text: t('sheet.accessId') }), el('dd', null, codeBox(o.accessId, { 'data-wds': 'access-id' })),
      owner ? el('dt', { text: t('sheet.recovery') }) : null, owner ? el('dd', null, codeBox(o.recoveryCode, { 'data-wds': 'recovery-code' })) : null,
    ]);
    var confirmId = uid('wds-ack');
    var ack = o.again ? null : el('input', { type: 'checkbox', id: confirmId, 'data-wds': 'sheet-confirm', onchange: function () { go.disabled = !ack.checked; } });
    var go = btn(t(o.again ? 'common.back' : 'common.continue'), { primary: true, disabled: !o.again, wds: 'sheet-continue', onClick: function () { onContinue(); } });   // o.again: the sheet shown again from the vault dialog
    append(dlg.body, [
      el('div', { 'data-wds': 'form-error', 'aria-live': 'polite' }),
      el('p', { text: owner ? t('sheet.intro.owner') : t('sheet.intro.member') }),
      dl,
      el('div', { class: 'wds-actions' }, [
        btn(t('sheet.print'), { wds: 'sheet-print', onClick: function () { printHtml(dlg.dialog, buildSheetHtml(data, t, S.lang)); } }),
        btn(t('sheet.download'), { wds: 'sheet-download', onClick: function () { downloadText(buildSheetHtml(data, t, S.lang), S.client.scope + '-access-sheet.html', 'text/html;charset=utf-8'); } }),
      ]),
      el('p', { text: t('sheet.passphrase.note') }),
      owner ? el('p', { text: t('sheet.recovery.note') }) : null,
      sandbox ? el('p', { text: t('sandbox.sheet.note') }) : null,
      o.hibpSkipped ? msg('warn', t('sheet.hibp.skipped')) : null,
      ack ? el('div', { class: 'wds-check' }, [ack, el('label', { for: confirmId, text: owner ? t('sheet.confirm.owner') : t('sheet.confirm.member') })]) : null,
      el('div', { class: 'wds-actions' }, [go]),
    ]);
    dlg.focusFirst();
  }

  // The access sheet after a vault exists (created or joined): it must not fail into the form of the step before (that would invite a second
  // submit although the vault is there). When the full sheet cannot be built, a plain one shows the access ID and the emergency code.
  function safeSheetView(S, dlg, o, onContinue) {
    try { sheetView(S, dlg, o, onContinue); return; }
    catch (e) { if (typeof console !== 'undefined' && console.error) console.error('wds: access sheet: ' + ((e && e.message) || e)); }
    var t = S.t, owner = !!o.recoveryCode && !isSandbox(S), ackId = uid('wds-ack');
    clear(dlg.body); dlg.setTitle(t('sheet.title'));
    var go = btn(t('common.continue'), { primary: true, disabled: true, wds: 'sheet-continue', onClick: function () { onContinue(); } });
    var ack = el('input', { type: 'checkbox', id: ackId, 'data-wds': 'sheet-confirm', onchange: function () { go.disabled = !ack.checked; } });
    append(dlg.body, [
      el('div', { 'data-wds': 'form-error', 'aria-live': 'polite' }),
      el('p', { text: owner ? t('sheet.intro.owner') : t('sheet.intro.member') }),
      el('p', { 'data-wds': 'access-id', text: o.accessId }),
      owner ? el('p', { 'data-wds': 'recovery-code', text: o.recoveryCode }) : null,
      el('p', { text: t('sheet.passphrase.note') }),
      el('div', { class: 'wds-check' }, [ack, el('label', { for: ackId, text: owner ? t('sheet.confirm.owner') : t('sheet.confirm.member') })]),
      el('div', { class: 'wds-actions' }, [go]),
    ]);
    dlg.setView('sheet');
  }

  // Returns a promise for {created: boolean}. o: {cancelable}.
  function runUnlock(S, o) {
    var t = S.t, client = S.client;
    return new Promise(function (resolve, reject) {
      var settled = false, dlg;
      var st = { accessId: client.rememberedAccessId() || '', inviteCode: '', notice: null };
      function done(result) { if (settled) return; settled = true; dlg.close(); resolve(result); }
      dlg = dialogFor(S, {
        title: t('unlock.title'), view: 'loading', cancelable: !!o.cancelable, closeLabel: t('common.close'),
        onClose: function () { if (!settled) { settled = true; reject(new Err.UsageError('unlock was cancelled', { code: 'cancelled' })); } },
      });
      function appLine() { return el('p', { class: 'wds-sub', text: t('unlock.app', { name: appLabel(S, S.info ? S.info.name : client.scope) }) }); }

      var loadGen = 0;   // every view switch bumps it: the answer of an earlier scope request must not replace the view that is shown now
      function frame(view, title, children) {
        loadGen++;
        clear(dlg.body); dlg.setTitle(title);
        append(dlg.body, children);
        dlg.setView(view);   // set when the controls are in place
      }

      // A sandbox is emptied every night: an access ID remembered from before the last wipe belongs to a vault that is gone.
      // The remembered time is that of the first remembering (the vault's creation), so a vault unlocked after the wipe time but
      // before the sweep that deleted it is recognised as well.
      function sandboxEmptied() {
        var sb = S.info && S.info.sandbox, mem = client.rememberedAccess();
        if (!(sb && mem && sb.last_wipe && mem.t < sb.last_wipe * 1000)) return false;
        client.forgetAccessId(); st.accessId = '';
        st.notice = { kind: 'warn', text: t('sandbox.emptied', { date: formatDate(sb.last_wipe, S.lang) }) };
        viewCreate();
        return true;
      }

      // ---- loading and fatal errors ----
      // A view that fails to build (an exception, not only a failed request) must not leave the dialog loading for ever: it ends in the
      // "error" view with a retry, which starts again at the scope information.
      function fatal(e) {
        if (typeof console !== 'undefined' && console.error) console.error('wds: unlock dialog: ' + ((e && e.message) || e));
        if (dlg.closed) return;
        loadGen++;
        try { showErrorView(S, dlg, t('unlock.title'), e, 'scope', function () { viewLoading(); }); }
        catch (e2) { dlg.setView('error'); }   // even then the dialog is no longer loading
      }
      function guarded(fn) { return function () { try { return fn.apply(this, arguments); } catch (e) { fatal(e); return undefined; } }; }
      function viewLoading() {
        frame('loading', t('unlock.title'), el('p', { role: 'status' }, [el('span', { class: 'wds-spin', 'aria-hidden': 'true' }), t('common.loading')]));
        var gen = loadGen;
        S.getInfo(true).then(function () {
          if (dlg.closed || gen !== loadGen) return;
          try {
            dlg.applySandbox(S);
            if (sandboxEmptied()) return;
            viewUnlock();
          } catch (e) { fatal(e); }
        }, function (e) { if (!dlg.closed && gen === loadGen) fatal(e); });
      }

      // ---- unlock ----
      function viewUnlockBody() {
        var idInput = inp({ mono: true, autocomplete: 'username', autocapitalize: 'characters', value: st.accessId ? Core.displayCode(st.accessId) : '', name: 'username', wds: 'access-id-input' });
        var fId = field({ label: t('unlock.accessId'), input: idInput, hint: t('unlock.accessId.hint') });
        var pw = passphraseGroup(S, { mode: 'current', label: t('unlock.passphrase') });
        var formErr = el('div', { 'aria-live': 'polite', 'data-wds': 'form-error' });
        var busy = busyLine();
        var fs = el('fieldset', { class: 'wds-fs' }, [
          el('p', { text: t('unlock.intro') }), appLine(),
          fId.wrap,
          pw.nodes, formErr,
          el('div', { class: 'wds-actions' }, [btn(t('unlock.submit'), { type: 'submit', primary: true, wds: 'unlock-submit' })]),
          busy,
        ]);
        var form = el('form', { class: 'wds-form', novalidate: 'novalidate', onsubmit: async function (ev) {
          ev.preventDefault();
          fId.clearError(); clear(formErr);
          var raw = idInput.value.trim();
          if (!raw) { fId.setError(t('err.accessId.missing')); idInput.focus(); return; }
          var kind = Core.classifyCode(raw);
          if (kind === 'invite') { st.inviteCode = raw; viewRedeem(); return; }
          if (kind === 'recovery') { fId.setError(t('unlock.recoveryEntered')); idInput.focus(); return; }
          if (kind !== 'access_id') { fId.setError(t('err.badId')); idInput.focus(); return; }
          var checked = await pw.validate();
          if (!checked) return;
          var accessId = Core.normalizeCode(raw);
          fs.disabled = true; dlg.setBusy(true); showBusy(busy, t('unlock.busy'));
          await nextPaint();
          try {
            await client.unlock({ accessId: accessId, passphrase: checked.passphrase, maintain: false });
            done({ created: false });
          } catch (e) {
            fs.disabled = false; dlg.setBusy(false); showBusy(busy, '');
            if (e && e.code === 'invite_not_redeemed') { st.inviteCode = raw; viewRedeem(); return; }
            append(formErr, msg('error', explainError(S, e, 'unlock')));
            if (e instanceof Err.AuthError && e.code !== 'revoked' && e.status !== 410) { pw.input.select(); pw.focus(); } else idInput.focus();
          }
        } }, fs);
        var links = el('div', { class: 'wds-actions' }, [linkBtn(t('unlock.toCreate'), viewCreate, 'to-create'), el('span', { class: 'wds-spacer' }), linkBtn(t('unlock.toRedeem'), function () { viewRedeem(); }, 'to-redeem')]);
        frame('unlock', t('unlock.title'), [st.notice ? msg(st.notice.kind, st.notice.text) : null, form, links]);
        st.notice = null;
        if (st.accessId) pw.focus(); else idInput.focus();
      }

      // ---- create ----
      function viewCreateBody() {
        var info = S.info || {};
        if (info.status === 'suspended') {
          frame('create', t('create.title'), [msg('warn', t('create.suspended')), el('div', { class: 'wds-actions' }, [btn(t('create.back'), { wds: 'back', onClick: viewUnlock })])]);
          dlg.focusFirst();
          return;
        }
        var sandbox = isSandbox(S);   // the sandbox is open; every other app asks for its join code
        var joinField = null, joinInput = null;
        if (!sandbox) {
          joinInput = inp({ mono: true, autocapitalize: 'characters', wds: 'join-code' });
          joinField = field({ label: t('create.joinCode'), input: joinInput, hint: t('create.joinCode.hint') });
        }
        var pw = passphraseGroup(S, { mode: 'new' });
        var formErr = el('div', { 'aria-live': 'polite', 'data-wds': 'form-error' });
        var busy = busyLine();
        var privacy = info.privacy_url && /^https?:\/\//i.test(info.privacy_url) ? el('a', { href: info.privacy_url, target: '_blank', rel: 'noopener noreferrer', text: t('create.privacy') }) : null;
        var fs = el('fieldset', { class: 'wds-fs' }, [
          el('p', { text: t('create.intro') }), appLine(),
          joinField ? joinField.wrap : null,
          pw.nodes, pw.note(),
          el('div', { class: 'wds-box' }, [el('h3', { text: t('escrow.title') }), el('p', { text: t(sandbox ? 'sandbox.create.escrow' : 'escrow.text') }), privacy ? el('p', null, privacy) : null]),
          formErr,
          el('div', { class: 'wds-actions' }, [btn(t(sandbox ? 'sandbox.create.submit' : 'create.submit'), { type: 'submit', primary: true, wds: 'create-submit' })]),
          busy,
        ]);
        var form = el('form', { class: 'wds-form', novalidate: 'novalidate', onsubmit: async function (ev) {
          ev.preventDefault();
          clear(formErr);
          if (joinField) { joinField.clearError(); if (!joinInput.value.trim()) { joinField.setError(t('err.joinCode.missing')); joinInput.focus(); return; } }
          var checked = await pw.validate();
          if (!checked) return;
          fs.disabled = true; dlg.setBusy(true); showBusy(busy, t('create.busy'));
          await nextPaint();
          try {
            var res = await client.createVault({ passphrase: checked.passphrase, joinCode: joinField ? joinInput.value.trim() : undefined });
            pw.reset();
            safeSheetView(S, dlg, {
              appName: appLabel(S, info.name || client.scope), accessId: res.accessIdDisplay, recoveryCode: res.recoveryCode.display,
              role: 'owner', hibpSkipped: checked.hibp && checked.hibp.status === 'unavailable',
            }, function () { done({ created: true }); });
          } catch (e) {
            fs.disabled = false; dlg.setBusy(false); showBusy(busy, '');
            if (joinField && e && e.code === 'join_code_invalid') {   // next to the field, which is far above the button on a long form
              joinField.setError(explainError(S, e, 'create')); joinInput.focus(); joinInput.select();
              if (joinInput.scrollIntoView) joinInput.scrollIntoView({ block: 'center' });
              return;
            }
            append(formErr, msg('error', explainError(S, e, 'create')));
          }
        } }, fs);
        frame('create', t('create.title'), [st.notice ? msg(st.notice.kind, st.notice.text) : null, form, el('div', { class: 'wds-actions' }, [linkBtn(t('create.back'), viewUnlock, 'back')])]);
        st.notice = null;
        (joinInput || pw.input).focus();
      }

      // ---- redeem ----
      function viewRedeemBody() {
        var info = S.info || {};
        var codeInput = inp({ mono: true, autocapitalize: 'characters', value: st.inviteCode ? Core.displayCode(Core.normalizeCode(st.inviteCode)) : '', wds: 'invite-code-input' });
        var fCode = field({ label: t('redeem.code'), input: codeInput, hint: t('redeem.code.hint') });
        var pw = passphraseGroup(S, { mode: 'new' });
        var formErr = el('div', { 'aria-live': 'polite', 'data-wds': 'form-error' });
        var busy = busyLine();
        var fs = el('fieldset', { class: 'wds-fs' }, [
          el('p', { text: t('redeem.intro') }), appLine(), fCode.wrap, pw.nodes, pw.note(), formErr,
          el('div', { class: 'wds-actions' }, [btn(t('redeem.submit'), { type: 'submit', primary: true, wds: 'redeem-submit' })]), busy,
        ]);
        var form = el('form', { class: 'wds-form', novalidate: 'novalidate', onsubmit: async function (ev) {
          ev.preventDefault();
          clear(formErr); fCode.clearError();
          var raw = codeInput.value.trim();
          if (Core.classifyCode(raw) !== 'invite') { fCode.setError(t('err.invite.invalid')); codeInput.focus(); return; }
          var checked = await pw.validate();
          if (!checked) return;
          fs.disabled = true; dlg.setBusy(true); showBusy(busy, t('redeem.busy'));
          await nextPaint();
          try {
            var res = await client.redeemInvite({ inviteCode: raw, passphrase: checked.passphrase, maintain: false });
            pw.reset();
            var accessId = Core.displayCode(res.accessId);
            clear(dlg.body);
            safeSheetView(S, dlg, { appName: appLabel(S, info.name || client.scope), accessId: accessId, recoveryCode: null, role: res.role, hibpSkipped: checked.hibp && checked.hibp.status === 'unavailable' }, function () { done({ created: false, redeemed: true }); });
            try {
              dlg.setTitle(t('redeem.done'));
              dlg.body.insertBefore(msg('ok', res.role === 'read' ? t('redeem.role.read') : t('redeem.role.write')), dlg.body.firstChild);
            } catch (e4) { /* the sheet is there; the line above it is a courtesy */ }
          } catch (e) {
            fs.disabled = false; dlg.setBusy(false); showBusy(busy, '');
            append(formErr, msg('error', explainError(S, e, 'redeem')));
          }
        } }, fs);
        frame('redeem', t('redeem.title'), [form, el('div', { class: 'wds-actions' }, [linkBtn(t('redeem.back'), viewUnlock, 'back')])]);
        (st.inviteCode ? pw.input : codeInput).focus();
      }

      var viewUnlock = guarded(viewUnlockBody), viewCreate = guarded(viewCreateBody), viewRedeem = guarded(viewRedeemBody);
      viewLoading();
    });
  }

  // ------------------------------------------------------------------------------------------------------------
  // 9. Conflict and history dialogs
  // ------------------------------------------------------------------------------------------------------------
  function sizeOfValue(v) {
    if (v === undefined || v === null) return 0;
    if (typeof v.size === 'number') return v.size;
    if (typeof v.byteLength === 'number') return v.byteLength;
    return v.length || 0;
  }
  function previewNode(S, side) {
    var t = S.t;
    if (!side) return el('p', { class: 'wds-hint', text: t('conflict.noTheirs') });
    if (side.deleted) return el('p', { class: 'wds-hint', text: side.who === 'mine' ? t('conflict.mineDeleted') : t('conflict.theirsDeleted') });
    if (side.kind === 'bytes') return el('p', { text: t('conflict.file', { mime: side.mime || 'application/octet-stream', size: formatBytes(sizeOfValue(side.value)) }) });
    var text;
    try { text = JSON.stringify(side.value, null, 2); } catch (e) { text = String(side.value); }
    if (text === undefined) text = '';
    var cut = text.length > 1500;
    return el('div', null, [el('pre', { class: 'wds-pre', tabindex: '0', text: cut ? text.slice(0, 1500) : text }), cut ? el('p', { class: 'wds-hint', text: t('conflict.truncated') }) : null]);
  }
  function markedName(name, marker, kind) {
    var base = fileSafe(name), dot = base.lastIndexOf('.'), slash = base.lastIndexOf('/');
    if (kind === 'json') return (/\.json$/i.test(base) ? base.slice(0, base.length - 5) : base) + '.' + marker + '.json';
    return dot > slash + 1 ? base.slice(0, dot) + '.' + marker + base.slice(dot) : base + '.' + marker;
  }

  // c: {name, mine: {value, kind, mime, deleted}, theirs: {version, deleted, kind, mime, time, value}|null}. -> 'mine' | 'theirs'
  function conflictDialog(S, c) {
    var t = S.t, isDelete = !!(c.mine && c.mine.deleted);
    return new Promise(function (resolve, reject) {
      var chosen = false;
      // A lock (the session ended while the question was open) closes the dialog: the write that asked fails like any write after a lock.
      var dlg = dialogFor(S, { title: t(isDelete ? 'conflict.delete.title' : 'conflict.title'), view: 'conflict', wide: true,
        onClose: function () { if (!chosen) reject(new Err.UsageError('the session ended while a conflict was waiting for a decision', { code: 'locked' })); } });
      function choose(which) { chosen = true; dlg.close(); resolve(which); }
      var theirs = c.theirs ? Object.assign({ who: 'theirs' }, c.theirs) : null;
      var mine = Object.assign({ who: 'mine' }, c.mine);
      var paneTheirs = el('section', { class: 'wds-pane', 'aria-labelledby': 'wds-c-theirs' }, [
        el('h3', { id: 'wds-c-theirs', text: t('conflict.theirs') }),
        theirs && theirs.time ? el('p', { class: 'wds-sub', text: t('conflict.saved', { time: formatTime(theirs.time / 1000, S.lang) }) }) : null,
        previewNode(S, theirs),
      ]);
      var paneMine = el('section', { class: 'wds-pane', 'aria-labelledby': 'wds-c-mine' }, [
        el('h3', { id: 'wds-c-mine', text: t('conflict.mine') }),
        previewNode(S, mine),
      ]);
      append(dlg.body, [
        el('div', { 'data-wds': 'form-error', 'aria-live': 'polite' }),
        el('p', { text: t(isDelete ? 'conflict.delete.intro' : 'conflict.intro', { name: S.label(c.name) }) }),
        el('div', { class: 'wds-compare' }, [paneTheirs, paneMine]),
        el('div', { class: 'wds-actions' }, [
          btn(t(isDelete ? 'conflict.delete.keepTheirs' : 'conflict.keepTheirs'), { primary: true, wds: 'conflict-theirs', onClick: function () { choose('theirs'); } }),
          btn(t(isDelete ? 'conflict.delete.keepMine' : 'conflict.keepMine'), { wds: 'conflict-mine', onClick: function () { choose('mine'); } }),
        ]),
      ]);
      dlg.focusFirst();
    });
  }

  // api: {history(name), getVersion(name, v), restore(name, v), role()}. Resolves {restored: n} or null.
  function historyDialog(S, name, api) {
    var t = S.t, title = S.label(name);
    return new Promise(function (resolve) {
      var result = null;
      // "loading" (busy) while the versions are read, "history" when the list is there, "error" with a retry when they cannot be read.
      var dlg = dialogFor(S, { title: t('history.title', { name: title }), view: 'loading', wide: true, cancelable: true, closeLabel: t('common.close'), onClose: function () { resolve(result); } });
      var list, previewBox, status;
      function load() {
        clear(dlg.body); dlg.setTitle(t('history.title', { name: title }));
        append(dlg.body, el('p', { role: 'status' }, [el('span', { class: 'wds-spin', 'aria-hidden': 'true' }), t('common.loading')]));
        dlg.setView('loading');
        api.history(name).then(function (h) { if (!dlg.closed) { try { show(h); } catch (e) { fail(e); } } }, function (e) { if (!dlg.closed) fail(e); });
      }
      function fail(e) { showErrorView(S, dlg, t('history.title', { name: title }), e, 'history', load); }
      function show(h) {
        list = el('ul', { class: 'wds-people' });
        previewBox = el('div', { 'aria-live': 'polite' });
        status = el('div', { 'aria-live': 'polite', 'data-wds': 'form-error' });
        clear(dlg.body);
        append(dlg.body, [el('p', { text: t('history.intro') }), status, list, previewBox]);
        dlg.setView('history');
        if (!h.versions.length) { list.parentNode.insertBefore(el('p', { text: t('history.empty') }), list); return; }
        h.versions.forEach(function (v) {
          var isCurrent = v.version === h.current;
          var previewBtn = btn(t('history.preview'), { small: true, wds: 'history-preview', disabled: v.deleted, onClick: async function () {
            clear(previewBox);
            try {
              var rec = await api.getVersion(name, v.version);
              if (!rec || rec.deleted) { previewBox.appendChild(msg('warn', t('history.unavailable'))); return; }
              append(previewBox, [el('h3', { text: t('history.version', { n: v.version }) }), previewNode(S, rec)]);
            } catch (e) { previewBox.appendChild(msg('error', explainError(S, e, 'history'))); }
          } });
          var readOnly = !!(api.role && api.role() === 'read');   // a read member cannot restore (it would be refused)
          var restoreBtn = btn(t('history.restore'), { small: true, wds: 'history-restore', primary: !isCurrent && !v.deleted && !readOnly, disabled: isCurrent || v.deleted || readOnly, onClick: async function () {
            restoreBtn.disabled = true; clear(status);
            try {
              await api.restore(name, v.version);
              result = { restored: v.version };
              dlg.close(result);
            } catch (e) { restoreBtn.disabled = false; status.appendChild(msg('error', explainError(S, e, 'history'))); }
          } });
          append(list, el('li', { class: 'wds-person', 'data-wds': 'history-version', 'data-wds-version': v.version }, [
            el('div', { class: 'wds-person-main' }, [
              el('div', { class: 'wds-person-name' }, [t('history.version', { n: v.version }), isCurrent ? el('span', { class: 'wds-badge', text: t('history.current') }) : null, v.deleted ? el('span', { class: 'wds-badge', text: t('history.deleted') }) : null]),
              el('div', { class: 'wds-person-info', text: formatTime(v.created, S.lang) }),
            ]),
            previewBtn, restoreBtn,
          ]));
        });
        dlg.focusFirst();
      }
      load();
    });
  }

  // ------------------------------------------------------------------------------------------------------------
  // 10. Share dialog: members, invites, revocation, own access
  // ------------------------------------------------------------------------------------------------------------
  function recoveryRequestNode(S, rec, onCancel, onKeep, bare) {
    var t = S.t;
    return el('div', { class: 'wds-msg wds-msg-warn', role: 'alert', 'data-wds': 'recovery-request' }, [
      bare ? null : el('strong', { text: t('share.recovery.title') }),
      el('p', { text: t('share.recovery.text', { time: formatTime(rec.requested, S.lang), ready: formatTime(rec.ready_at, S.lang) }) }),
      el('div', { class: 'wds-actions' }, [btn(t('share.recovery.cancel'), { danger: true, wds: 'recovery-cancel', onClick: onCancel }), onKeep ? btn(t('share.recovery.keep'), { wds: 'recovery-keep', onClick: onKeep }) : null]),
    ]);
  }
  function recoveredNode(S, onAck, bare) {
    var t = S.t;
    return el('div', { class: 'wds-msg wds-msg-warn', role: 'alert', 'data-wds': 'recovered-notice' }, [
      bare ? null : el('strong', { text: t('share.recovered.title') }),
      el('p', { text: t('share.recovered.text') }),
      el('div', { class: 'wds-actions' }, [btn(t('share.recovered.ack'), { primary: true, wds: 'recovered-ack', onClick: onAck })]),
    ]);
  }
  function shortId(slotId) { return String(slotId).slice(0, 8); }
  function foreignRecoverySlots(status) { return (status.recoverySlots || []).filter(function (id) { return id !== status.slotId; }); }

  // The vault dialog (every role): members and invites (owner), own access, access sheet, passphrase, export, lock.
  // api: {labels: {get(), set(slotId, text|null), drop(slotId)}, acked, seen: {get(), add(ids)}, lock(), onRevoked(), exportAll(onProgress)}
  function shareDialog(S, api) {
    var t = S.t, client = S.client;
    return new Promise(function (resolve) {
      var dlg = dialogFor(S, { title: t('share.title'), view: 'share', wide: true, cancelable: true, closeLabel: t('common.close'), onClose: function () { resolve(); } });
      // inviteRole and inviteLabel are what the person chose in the invite form: any re-render (the roster refresh, a flash, a failed attempt) shows them again.
      var st = { view: 'main', invite: null, flash: null, revokeSlot: null, inviteRole: 'write', inviteLabel: '' };
      var locked = false, maintaining = false;

      function setFlash(kind, text) { st.flash = text ? { kind: kind, text: text } : null; }
      function explain(e) {
        if (e && e.code === 'recovery_unacknowledged') return t('share.error.recoveryAck');
        return t('share.error.generic', { message: explainError(S, e, 'share') });
      }
      async function guard(fn) {
        try { return await fn(); } catch (e) {
          if (e instanceof Err.AuthError && (e.code === 'revoked' || e.status === 401)) { api.onRevoked(); dlg.close(); return undefined; }
          setFlash('error', explain(e)); st.view = 'main'; render(); return undefined;
        }
      }

      function labelOf(m, idx) {
        if (m.self) return t('share.you');
        if (m.escrow) return t('share.escrow');
        return (api.labels.get()[m.slotId]) || (m.role === 'owner' ? t('share.otherOwner') : t('share.member') + ' ' + idx);
      }

      // ---- progress view (revocation and re-encryption) ----
      function viewProgress(titleText, work) {
        clear(dlg.body); dlg.setView('progress');
        dlg.setCancelable(false);
        var bar = el('progress', { class: 'wds-progress', 'aria-label': titleText });
        var line = el('p', { role: 'status', 'aria-live': 'polite', text: t('share.revoke.starting') });
        append(dlg.body, [el('p', { text: titleText }), bar, line]);
        var total = 0;
        work(function (p) {
          total = Math.max(total, p.rekeyed + p.remaining);
          bar.max = total || 1; bar.value = p.rekeyed;
          line.textContent = t('share.revoke.progress', { done: p.rekeyed, total: total });
        }).then(function (r) {
          dlg.setCancelable(true);
          setFlash('ok', r && r.done === false ? t('share.revoke.partial') : t('share.revoke.done'));
          st.view = 'main'; render('close');
        }, function (e) {
          dlg.setCancelable(true);
          if (e instanceof Err.AuthError && (e.code === 'revoked' || e.status === 401)) { api.onRevoked(); dlg.close(); return; }
          setFlash('error', explain(e) + ' ' + t('share.revoke.partial')); st.view = 'main'; render();
        });
      }

      // ---- views ----
      function viewRevokeConfirm() {
        var m = st.revokeSlot, textKey = m.invite ? 'share.revoke.invite.text' : m.owner ? 'share.revoke.owner.text' : 'share.revoke.text';
        clear(dlg.body); dlg.setTitle(t('share.revoke.title')); dlg.setView('revoke');
        append(dlg.body, [
          el('p', { text: t(textKey, { label: m.label }) }),
          el('p', { class: 'wds-hint', 'data-wds': 'revoke-id', text: t('share.revoke.id', { id: shortId(m.slotId) }) }),
          el('div', { class: 'wds-actions' }, [
            btn(t('share.revoke.confirm'), { danger: true, wds: 'revoke-confirm', onClick: function () {
              dlg.setTitle(t('share.title'));
              viewProgress(t(textKey, { label: m.label }), function (onProgress) {
                return client.revoke(m.slotId, { onProgress: onProgress }).then(function (r) { return api.labels.drop(m.slotId).then(function () { return r; }, function () { return r; }); });
              });
            } }),
            btn(t('common.cancel'), { wds: 'revoke-cancel', onClick: function () { dlg.setTitle(t('share.title')); st.view = 'main'; render(); } }),
          ]),
        ]);
        dlg.focusFirst();
      }

      function inviteSection() {
        if (st.invite) {
          var inv = st.invite;
          var copied = el('span', { class: 'wds-hint', role: 'status', 'aria-live': 'polite' });
          return el('div', { class: 'wds-section' }, [
            el('h3', { text: t('share.invite.title') }),
            el('p', { class: 'wds-label', text: t('share.invite.result') }),
            codeBox(inv.code.display, { 'data-wds': 'invite-code', tabindex: '0' }),
            el('p', { class: 'wds-hint', text: t('share.invite.until', { time: formatTime(inv.expires, S.lang) }) }),
            el('div', { class: 'wds-actions' }, [
              btn(t('common.copy'), { wds: 'invite-copy', onClick: function () {
                var done = function () { copied.textContent = t('common.copied'); };
                try { navigator.clipboard.writeText(inv.code.display).then(done, function () {}); } catch (e) { /* select manually */ }
              } }),
              btn(t('share.invite.another'), { wds: 'invite-another', onClick: function () { st.invite = null; render('invite-role'); } }),
              copied,
            ]),
            el('p', { class: 'wds-hint', text: t('share.invite.hint') }),
          ]);
        }
        var role = el('select', { class: 'wds-select', id: uid('wds-role'), 'data-wds': 'invite-role', onchange: function () { st.inviteRole = role.value; } }, [
          el('option', { value: 'write', text: t('role.write') }), el('option', { value: 'read', text: t('role.read') }),
        ]);
        role.value = st.inviteRole;
        // Valid for 2 days. The server refuses an invite that outlives the next nightly wipe of a sandbox: there it is valid until then (with a margin for clock differences).
        var expiresIn = 172800;
        if (isSandbox(S)) {
          var wipeAt = S.info.sandbox.next_wipe, left = Math.floor(wipeAt - S.now() / 1000) - 300;
          if (left < 3600) {
            return el('div', { class: 'wds-section' }, [el('h3', { text: t('share.invite.title') }), msg('warn', t('share.invite.sandboxLate', { time: formatTime(wipeAt, S.lang) }))]);
          }
          expiresIn = Math.min(left, expiresIn);
        }
        var labelInput = inp({ maxlength: 60, wds: 'invite-label', value: st.inviteLabel });
        labelInput.addEventListener('input', function () { st.inviteLabel = labelInput.value; });
        var fLabel = field({ label: t('share.invite.label'), input: labelInput, hint: t('share.invite.label.hint') });
        var busy = busyLine();
        var fs = el('fieldset', { class: 'wds-fs' }, [
          el('div', { class: 'wds-field' }, [el('label', { class: 'wds-label', for: role.id, text: t('share.invite.role') }), role]),
          fLabel.wrap,
          el('div', { class: 'wds-actions' }, [btn(t('share.invite.create'), { type: 'submit', primary: true, wds: 'invite-create' })]), busy,
        ]);
        return el('div', { class: 'wds-section' }, [
          el('h3', { text: t('share.invite.title') }),
          el('form', { novalidate: 'novalidate', onsubmit: async function (ev) {
            ev.preventDefault();
            fs.disabled = true; st.submitting = true; showBusy(busy, t('share.invite.busy'));
            try {
              var res = await client.createInvite({ role: role.value, expiresIn: expiresIn });
              var label = labelInput.value.trim();
              if (label) { try { await api.labels.set(res.slotId, label); } catch (e) { /* label is a convenience */ } }
              st.submitting = false; st.invite = res; st.inviteRole = 'write'; st.inviteLabel = ''; setFlash(null); render('invite-code');
            } catch (e) {
              st.submitting = false; fs.disabled = false; showBusy(busy, '');
              if (e instanceof Err.AuthError && (e.code === 'revoked' || e.status === 401)) { api.onRevoked(); dlg.close(); return; }
              setFlash('error', explain(e)); render();
            }
          } }, fs),
        ]);
      }

      function peopleSection(members) {
        var idx = 0;
        var items = members.map(function (m) {
          if (!m.self && !m.escrow) idx++;
          var label = labelOf(m, idx);
          var badges = [];
          if (m.escrow) badges.push(el('span', { class: 'wds-badge', text: t('share.escrow.badge') }));   // not "owner": the faculty does not own the vault
          else if (m.role === 'owner' || m.self) badges.push(el('span', { class: 'wds-badge', text: t('role.' + m.role) }));
          var info = [];
          if (m.escrow) info.push(t(isSandbox(S) ? 'sandbox.share.escrow' : 'escrow.text'));
          else if (m.kind === 'invite' && !m.redeemed) {
            info.push(m.expired ? t('share.status.expired') : t(m.used ? 'share.status.opened' : 'share.status.invited', { time: formatTime(m.expires, S.lang) }));
          }
          else if (m.redeemed) info.push(t('share.status.redeemed', { time: formatTime(m.redeemed, S.lang) }));
          else info.push(t('share.status.active'));
          if (m.renewalPending && !m.escrow) info.push(t('share.status.renewal'));
          if (m.addedByEscrow) info.push(t('share.addedByFaculty'));
          if (!m.self && !m.escrow) info.push(t('share.slotId', { id: shortId(m.slotId) }));
          var actions = [];
          if (!m.self && !m.escrow && m.role !== 'owner') {
            var sel = el('select', { class: 'wds-select', style: 'width:auto', 'data-wds': 'member-role', 'aria-label': t('share.role', { label: label }), onchange: function () {
              guard(async function () { await client.setRole(m.slotId, sel.value); setFlash(null); render(); });
            } }, [el('option', { value: 'write', text: t('role.write') }), el('option', { value: 'read', text: t('role.read') })]);
            sel.value = m.role;
            actions.push(sel);
            if (m.kind === 'invite' && !m.redeemed && !m.used) {
              // An invite that nobody has used leaves quietly. If the server saw its token in the meantime, cancelInvite
              // refuses (revocation_required) and the revocation dialog takes over.
              actions.push(btn(t('share.cancelInvite'), { small: true, wds: 'cancel-invite', onClick: function () {
                guard(async function () {
                  try { await client.cancelInvite(m.slotId, { revoke: false }); } catch (e) {
                    if (e && e.code === 'revocation_required') { st.revokeSlot = { slotId: m.slotId, label: label, owner: false, invite: true }; st.view = 'revoke'; render(); return; }
                    throw e;
                  }
                  await api.labels.drop(m.slotId).catch(function () {}); setFlash(null); render();
                });
              } }));
            } else {
              // Used or redeemed: it can only be withdrawn like a member, by a revocation (new key, re-encryption).
              var withdrawn = m.kind === 'invite' && !m.redeemed;
              actions.push(btn(t('share.revoke'), { small: true, danger: true, wds: 'revoke', onClick: function () { st.revokeSlot = { slotId: m.slotId, label: label, owner: false, invite: withdrawn }; st.view = 'revoke'; render(); } }));
            }
          }
          if (!m.self && !m.escrow && m.role === 'owner' && m.revocable) {
            actions.push(btn(t('share.revoke'), { small: true, danger: true, wds: 'revoke', onClick: function () { st.revokeSlot = { slotId: m.slotId, label: label, owner: true }; st.view = 'revoke'; render(); } }));
          }
          return el('li', { class: 'wds-person', 'data-wds': m.escrow ? 'person-escrow' : 'person' }, [
            el('div', { class: 'wds-person-main' }, [el('div', { class: 'wds-person-name' }, [label, badges]), el('div', { class: 'wds-person-info', text: info.join(' · ') })]),
            actions,
          ]);
        });
        return el('div', { class: 'wds-section' }, [el('h3', { text: t('share.people') }), el('ul', { class: 'wds-people' }, items), el('p', { class: 'wds-hint', text: t('share.labels.hint') })]);
      }

      function mySection(status) {
        var parts = [el('h3', { text: t('share.me.title') }), el('p', { text: t('share.me.role', { role: t('role.' + status.role) }) })];
        if (status.role !== 'owner') parts.push(el('p', { class: 'wds-hint', text: t('share.me.onlyOwner') }));
        // each button with its own explanation directly below it
        parts.push(el('div', { class: 'wds-act' }, [
          btn(t('share.me.sheet'), { wds: 'me-sheet', onClick: showSheet }),
          el('p', { class: 'wds-hint', text: t('share.me.sheet.hint') }),
        ]));
        var exportLine = el('p', { class: 'wds-hint', role: 'status', 'aria-live': 'polite', text: t('share.me.export.hint') });
        parts.push(el('div', { class: 'wds-act' }, [
          btn(t('share.me.export'), { wds: 'me-export', onClick: function (ev) {
            var b = ev.currentTarget; b.disabled = true; st.submitting = true;
            api.exportAll(function (done, total) { exportLine.textContent = t('note.exporting', { done: done, total: total }); })
              .then(function (r) { exportLine.textContent = t('note.exported', { n: r.count }); }, function (e) { exportLine.textContent = explain(e); })
              .then(function () { b.disabled = false; st.submitting = false; });
          } }),
          exportLine,
        ]));
        parts.push(el('div', { class: 'wds-act' }, [
          btn(t('share.me.lock'), { wds: 'me-lock', onClick: function () { locked = true; api.lock(); dlg.close(); } }),
          el('p', { class: 'wds-hint', text: t('share.me.lock.hint') }),
        ]));
        var pw = passphraseGroup(S, { mode: 'new', label: t('share.me.passphrase.new'), hint: null });
        var busy = busyLine(), out = el('div', { 'aria-live': 'polite' });
        var fs = el('fieldset', { class: 'wds-fs' }, [pw.nodes, pw.note(), el('div', { class: 'wds-actions' }, [btn(t('share.me.passphrase.submit'), { type: 'submit', primary: true, wds: 'me-passphrase-submit' })]), busy]);
        parts.push(el('details', { class: 'wds-details' }, [el('summary', { text: t('share.me.passphrase'), 'data-wds': 'me-passphrase-toggle' }),
          el('form', { novalidate: 'novalidate', onsubmit: async function (ev) {
            ev.preventDefault(); clear(out);
            var checked = await pw.validate();
            if (!checked) return;
            fs.disabled = true; st.submitting = true; dlg.setBusy(true); showBusy(busy, t('unlock.busy'));
            await nextPaint();
            try { await client.changePassphrase(checked.passphrase); pw.reset(); out.appendChild(msg('ok', t('share.me.passphrase.done'))); }
            catch (e) { out.appendChild(msg('error', explain(e))); }
            fs.disabled = false; st.submitting = false; dlg.setBusy(false); showBusy(busy, '');
          } }, fs), out]));
        return el('div', { class: 'wds-section' }, parts);
      }

      // The access sheet again (no emergency code: that exists only once, at creation).
      function showSheet() {
        var status = client.status();
        st.view = 'sheet';
        sheetView(S, dlg, { appName: appLabel(S, (S.info && S.info.name) || client.scope), accessId: Core.displayCode(status.accessId), recoveryCode: null, role: status.role, again: true }, function () { st.view = 'main'; render(); });
      }

      // A view that cannot be built (an exception) ends in the "error" view with a retry, never in a half-built dialog.
      function render(focusKey) {
        try { renderBody(focusKey); }
        catch (e) {
          if (typeof console !== 'undefined' && console.error) console.error('wds: share dialog: ' + ((e && e.message) || e));
          if (!dlg.closed) showErrorView(S, dlg, t('share.title'), e, 'share', function () { st.view = 'main'; render(); });
        }
      }
      function renderBody(focusKey) {
        if (dlg.closed) return;
        if (st.view === 'revoke') { viewRevokeConfirm(); return; }
        var status = client.status();
        if (!status.unlocked) { dlg.close(); return; }
        clear(dlg.body); dlg.setTitle(t('share.title')); dlg.setView('share');
        if (maintaining) dlg.setBusy(true);   // the roster is being refreshed: ready when aria-busy is gone
        var owner = status.role === 'owner';
        var banners = [];
        banners.push(el('div', { 'data-wds': 'form-error', 'aria-live': 'polite' }, st.flash ? msg(st.flash.kind, st.flash.text) : null));
        if (owner && status.recovery) {
          banners.push(recoveryRequestNode(S, status.recovery, function () {
            guard(async function () { await client.cancelRecovery(); setFlash('ok', t('share.recovery.cancelled')); render(); });
          }));
        }
        var freshRecovered = owner ? api.acked.pending(status) : [];
        if (freshRecovered.length) {
          banners.push(recoveredNode(S, function () { api.acked.confirm(freshRecovered); render(); }));
        }
        if (owner && status.rekeyPending) {
          banners.push(el('div', { class: 'wds-msg wds-msg-warn', role: 'status' }, [
            el('p', { text: t('share.rekey.pending') }),
            el('div', { class: 'wds-actions' }, [btn(t('share.rekey.continue'), { primary: true, wds: 'rekey-continue', onClick: function () {
              viewProgress(t('share.rekey.pending'), function (onProgress) { return client.resumeRekey({ onProgress: onProgress }); });
            } })]),
          ]));
        }
        var members = [];
        if (owner) members = client.members().sort(function (a, b) { return (b.self ? 1 : 0) - (a.self ? 1 : 0) || (a.escrow ? 1 : 0) - (b.escrow ? 1 : 0); });
        append(dlg.body, banners);
        // Looking at the roster answers the "someone joined" notice that follows an unlock.
        if (owner) { append(dlg.body, [peopleSection(members), inviteSection()]); api.seen.add(members.filter(function (m) { return m.redeemed; }).map(function (m) { return m.slotId; })); }
        append(dlg.body, mySection(status));
        var target = focusKey && dlg.body.querySelector('[data-wds="' + focusKey + '"],[data-focus="' + focusKey + '"]');
        if (target) target.focus(); else dlg.dialog.focus();
      }

      // Bring the roster up to date (redemptions, key renewals) without blocking the first paint; aria-busy stays until that is done.
      maintaining = client.status().role === 'owner';
      render();
      if (maintaining) {
        var snapshot = function () { try { var s = client.status(); return JSON.stringify([client.members(), s.recovery, s.rekeyPending]); } catch (e) { return ''; } };
        var before = snapshot();
        // Draw the dialog again only when the roster changed and the person is not typing in a form or has one in flight.
        var settle = function (ok) {
          maintaining = false;
          if (dlg.closed || locked || st.view !== 'main') return;   // the other views set aria-busy themselves
          var f = document.activeElement, inBody = f && dlg.body.contains(f);
          if (ok && snapshot() !== before && !st.submitting && !(inBody && f.closest('form'))) render(inBody ? f.getAttribute('data-wds') : null);
          else if (!st.submitting) dlg.setBusy(false);
        };
        client.maintain().then(function () { settle(true); }, function () { settle(false); /* the banners explain what is needed */ });
      }
    });
  }

  // ------------------------------------------------------------------------------------------------------------
  // 10b. store.migrateLocal, helpers: the old browser storage, ids, comparing values
  // ------------------------------------------------------------------------------------------------------------
  var MIGRATE_ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
  var MIGRATE_OPTIONS = ['id', 'indexedDB', 'localStorage', 'map'];
  var TEST_HOOKS = {};   // library tests only (not documented)

  // A run that ends as { status: 'failed', why }: thrown inside the run, turned into the result.
  function MigrateStop(why) { var e = new Error(why); e.isMigrateStop = true; e.why = why; return e; }
  function hexLower(bytes) { var s = ''; for (var i = 0; i < bytes.length; i++) s += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16); return s; }
  function fnv1a(s) { var h = 0x811c9dc5; for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return ('0000000' + h.toString(16)).slice(-8); }
  function isBlobValue(v) { return typeof Blob !== 'undefined' && v instanceof Blob; }
  function isBinaryValue(v) { return v instanceof ArrayBuffer || ArrayBuffer.isView(v); }
  function bytesOf(v) { return v instanceof ArrayBuffer ? new Uint8Array(v) : new Uint8Array(v.buffer, v.byteOffset, v.byteLength); }
  async function bytesEqual(a, b) {   // Blob/binary against Blob/binary
    var x = isBlobValue(a) ? new Uint8Array(await a.arrayBuffer()) : bytesOf(a), y = isBlobValue(b) ? new Uint8Array(await b.arrayBuffer()) : bytesOf(b);
    if (x.length !== y.length) return false;
    for (var i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
    return true;
  }
  function sameJson(a, b) { try { return JSON.stringify(a) === JSON.stringify(b); } catch (e) { return false; } }

  // The id part for an old key: "s" + the string, "b" + hex for binary keys, "j" + the JSON text for everything else (numbers, arrays, dates).
  // Different keys never give the same token (1 and "1" differ), and a token never contains "/".
  function migrateKeyToken(key) {
    try {
      if (typeof key === 'string') return 's' + encodeURIComponent(key);
      if (isBinaryValue(key)) return 'b' + hexLower(bytesOf(key));
      var text = JSON.stringify(key);
      if (text === undefined) throw new Error('no JSON form');
      return 'j' + encodeURIComponent(text);
    } catch (e) { throw MigrateStop('this key cannot be turned into an id: ' + String(key).slice(0, 60)); }
  }
  // The stable id of an old row: the tag of this browser, the store, the key. Same input, same id: a reference computes it with the same call.
  function migrateRowId(tag, source, key) {
    var id = tag + '-' + fnv1a(source) + '-' + migrateKeyToken(key);
    return id.length > 200 ? id.slice(0, 180) + '~' + fnv1a(id) : id;
  }
  // A key-sorted picture of an old value as text (a file by size, type, name and date): same picture, same data. Throws for a cycle.
  function canonText(v) {
    try { return canonJson(v); } catch (e) { throw new Error('a value that contains itself (or is nested too deeply) cannot be copied'); }
  }
  function canonJson(v) {
    return JSON.stringify(v, function (k, x) {
      if (isBlobValue(x)) return { $blob: [x.size, x.type, x.name, x.lastModified] };
      if (isBinaryValue(x)) return { $bytes: x.byteLength };
      if (x instanceof Map) return { $map: Array.from(x.entries()) };
      if (x instanceof Set) return { $set: Array.from(x.values()) };
      if (typeof x === 'bigint') return { $bigint: String(x) };
      if (x && typeof x === 'object' && !Array.isArray(x)) { var o = {}; Object.keys(x).sort().forEach(function (key) { o[key] = x[key]; }); return o; }
      return x === undefined ? { $undefined: 1 } : x;
    });
  }
  function migrateRowFp(r) { return r.source === 'localStorage' ? r.value : canonText(r.value); }   // what a row holds, compared before it is deleted
  function migrateRowKey(r) { return r.source + '\x00' + migrateKeyToken(r.key); }
  // What the page remembers of a copied row: a hash of its key and content. A row that changed after the copy is not the one that was copied.
  async function migrateRowHash(r) {
    var d = await crypto.subtle.digest('SHA-256', utf8(migrateRowKey(r) + '\x00' + migrateRowFp(r)));
    return hexLower(new Uint8Array(d)).slice(0, 16);
  }
  // A value that is to be stored as JSON must not hold a file, Map or Set (JSON would write {}), BigInt, a function or a cycle.
  function migrateCheckJson(v, where, depth) {
    if (v === null || typeof v !== 'object') {
      if (typeof v === 'bigint' || typeof v === 'function' || typeof v === 'symbol') throw MigrateStop(where + ' holds a ' + typeof v + ', which JSON cannot store');
      return;
    }
    if (depth > 60) throw MigrateStop(where + ' is nested too deeply or contains itself');
    if (isBlobValue(v) || isBinaryValue(v) || v instanceof Map || v instanceof Set) throw MigrateStop(where + ' holds a file, Map or Set inside a JSON value, which would be stored as {}; store a file as its own record and refer to its id');
    Object.keys(v).forEach(function (k) { migrateCheckJson(v[k], where, depth + 1); });
  }
  // The options of migrateLocal (UsageError for anything that is wrong before the run starts).
  function migrateParse(o) {
    if (!o || typeof o !== 'object') throw new Err.UsageError('migrateLocal needs an options object { id, indexedDB?, localStorage?, map }');
    Object.keys(o).forEach(function (k) {
      if (MIGRATE_OPTIONS.indexOf(k) < 0) throw new Err.UsageError('migrateLocal: unknown option "' + k + '"; known options: ' + MIGRATE_OPTIONS.join(', '));
    });
    if (typeof o.id !== 'string' || !MIGRATE_ID_RE.test(o.id)) throw new Err.UsageError('migrateLocal: id must be 1 to 40 characters: lowercase letters, digits and "-", starting with a letter or digit');
    if (typeof o.map !== 'function') throw new Err.UsageError('migrateLocal: map must be a function (old, ref) => write | [writes]');
    var cfg = { id: o.id, map: o.map, dbs: [], local: [] }, idb = o.indexedDB === undefined || o.indexedDB === null ? {} : o.indexedDB;
    if (typeof idb !== 'object' || Array.isArray(idb)) throw new Err.UsageError('migrateLocal: indexedDB must look like { "database": ["store", ...] }');
    Object.keys(idb).forEach(function (db) {
      if (!Array.isArray(idb[db]) || !idb[db].length || idb[db].some(function (s) { return typeof s !== 'string' || !s; })) throw new Err.UsageError('migrateLocal: indexedDB "' + db + '" needs a list of store names');
      cfg.dbs.push({ name: db, stores: idb[db].slice() });
    });
    var ls = o.localStorage === undefined || o.localStorage === null ? [] : o.localStorage;
    if (!Array.isArray(ls)) throw new Err.UsageError('migrateLocal: localStorage must be a list of keys, or "prefix*" for every key with that prefix');
    ls.forEach(function (k) {
      if (typeof k !== 'string' || !k || k === '*') throw new Err.UsageError('migrateLocal: a localStorage entry is a key, or "prefix*"');
      if (k.indexOf('wds:') === 0) throw new Err.UsageError('migrateLocal: localStorage keys starting with "wds:" belong to the library');
      cfg.local.push(k.slice(-1) === '*' ? { prefix: k.slice(0, -1) } : { key: k });
    });
    if (!cfg.dbs.length && !cfg.local.length) throw new Err.UsageError('migrateLocal: name a source: indexedDB: { db: [stores] } and/or localStorage: [keys]');
    return cfg;
  }

  function idbRequest(req) { return new Promise(function (resolve, reject) { req.onsuccess = function () { resolve(req.result); }; req.onerror = function () { reject(req.error); }; }); }
  // Opens an existing database without creating it (a missing one: null). A database that stays blocked (an upgrade in another tab) fails after 5 s.
  function idbOpenExisting(name) {
    return new Promise(function (resolve, reject) {
      var req, existed = true, settled = false;
      try { req = indexedDB.open(name); } catch (e) { reject(e); return; }
      var timer = setTimeout(function () { if (!settled) { settled = true; reject(MigrateStop('the old database "' + name + '" is busy (another tab is upgrading it)')); } }, 5000);
      function end(fn, v) { if (settled) { if (fn === resolve && v) { try { v.close(); } catch (e) { /* ignore */ } } return; } settled = true; clearTimeout(timer); fn(v); }
      req.onupgradeneeded = function () { existed = false; try { req.transaction.abort(); } catch (e) { /* ignore */ } };
      req.onsuccess = function () {
        var db = req.result;
        db.onversionchange = function () { try { db.close(); } catch (e) { /* ignore */ } };
        if (!existed) { try { db.close(); } catch (e) { /* ignore */ } end(resolve, null); } else end(resolve, db);
      };
      req.onerror = function () { if (!existed) end(resolve, null); else end(reject, req.error); };
    });
  }
  function localMatches(cfg, key) { return cfg.local.some(function (m) { return m.key !== undefined ? m.key === key : key.indexOf(m.prefix) === 0; }); }
  // Reads the configured old storage without changing it: [{ source, key, value, db?, store? }]. source is "database/store" or "localStorage".
  async function migrateRead(cfg) {
    var rows = [];
    if (typeof indexedDB !== 'undefined' && indexedDB) {
      for (var i = 0; i < cfg.dbs.length; i++) {
        var d = cfg.dbs[i], db = null;
        try { db = await idbOpenExisting(d.name); } catch (e) { if (e && e.isMigrateStop) throw e; continue; }
        if (!db) continue;
        try {
          for (var j = 0; j < d.stores.length; j++) {
            if (!db.objectStoreNames.contains(d.stores[j])) continue;
            var os = db.transaction(d.stores[j], 'readonly').objectStore(d.stores[j]), pk = idbRequest(os.getAllKeys()), pv = idbRequest(os.getAll());
            var keys = await pk, vals = await pv;
            for (var k = 0; k < keys.length; k++) rows.push({ source: d.name + '/' + d.stores[j], db: d.name, store: d.stores[j], key: keys[k], value: vals[k] });
          }
        } catch (e) { throw MigrateStop('could not read the old database "' + d.name + '": ' + ((e && e.message) || e)); }
        finally { try { db.close(); } catch (e) { /* ignore */ } }
      }
    }
    try {
      for (var n = 0; n < localStorage.length; n++) {
        var key = localStorage.key(n);
        if (key === null || key.indexOf('wds:') === 0 || !localMatches(cfg, key)) continue;
        var val = localStorage.getItem(key);
        if (val !== null) rows.push({ source: 'localStorage', key: key, value: val });
      }
    } catch (e) { /* storage not readable: nothing to take over from it */ }
    return rows;
  }
  function migrateRowLabel(r) { return r.source + ' key ' + (isBinaryValue(r.key) ? '(binary)' : JSON.stringify(r.key)); }

  // The backup: a ZIP file with data.json (all rows; files replaced by references) and every Blob/binary value under files/.
  async function migrateBackupBlob(cfg, rows) {
    var files = [];
    async function conv(v, seen) {
      if (v === undefined || typeof v === 'function' || typeof v === 'symbol') return null;
      if (typeof v === 'bigint') return { $bigint: v.toString() };
      if (v === null || typeof v !== 'object') return v;
      if (isBlobValue(v) || isBinaryValue(v)) {
        var data = isBlobValue(v) ? new Uint8Array(await v.arrayBuffer()) : new Uint8Array(bytesOf(v)), nm = 'files/' + ('0000' + (files.length + 1)).slice(-4) + '-' + fileSafe(isBlobValue(v) && v.name ? v.name : 'data');
        files.push({ name: nm, data: data });
        return { $file: nm, size: data.length, type: isBlobValue(v) && v.type ? v.type : undefined };
      }
      if (v instanceof Date) return { $date: isNaN(v.getTime()) ? null : v.toISOString() };
      if (seen.indexOf(v) >= 0) return { $cycle: true };
      seen.push(v);
      var out, list;
      if (Array.isArray(v)) { out = []; for (var i = 0; i < v.length; i++) out.push(await conv(v[i], seen)); }
      else if (v instanceof Map || v instanceof Set) { out = { $collection: v instanceof Map ? 'map' : 'set', items: [] }; list = Array.from(v instanceof Map ? v.entries() : v.values()); for (var j = 0; j < list.length; j++) out.items.push(await conv(list[j], seen)); }
      else { out = {}; list = Object.keys(v); for (var q = 0; q < list.length; q++) out[list[q]] = await conv(v[list[q]], seen); }
      seen.pop();
      return out;
    }
    var doc = { app: cfg.id, date: new Date().toISOString(), note: 'Not encrypted. Values of files are in the folder files/.', rows: [] };
    for (var a = 0; a < rows.length; a++) doc.rows.push({ source: rows[a].source, key: await conv(rows[a].key, []), value: await conv(rows[a].value, []) });
    return makeZip([{ name: 'data.json', data: JSON.stringify(doc, null, 1) }].concat(files));   // beyond what a ZIP file holds (4 GiB) this throws: the dialog says that the copy failed
  }

  // Deletes the given rows (all of them were copied, and the person confirmed). IndexedDB: per database one readwrite transaction that compares each row
  // with what was copied and aborts when one differs; localStorage: a key is removed only when it still holds the copied text. Never anything else.
  async function migrateDelete(rows) {
    var byDb = {};
    rows.forEach(function (c) { if (c.db) (byDb[c.db] = byDb[c.db] || []).push(c); });
    var dbNames = Object.keys(byDb);
    for (var d = 0; d < dbNames.length; d++) {
      var db = await idbOpenExisting(dbNames[d]);
      if (!db) continue;
      try {
        var rs = byDb[dbNames[d]], stores = Array.from(new Set(rs.map(function (x) { return x.store; })));
        await new Promise(function (resolve, reject) {
          var tx = db.transaction(stores, 'readwrite');
          tx.oncomplete = resolve;
          tx.onabort = function () { reject(MigrateStop('the old data changed while it was being deleted; nothing more was deleted')); };
          rs.forEach(function (row) {
            var os = tx.objectStore(row.store);
            os.get(row.key).onsuccess = function (ev) {
              if (migrateRowFp({ source: row.source, value: ev.target.result }) !== row.fp) { try { tx.abort(); } catch (e) { /* ignore */ } } else os.delete(row.key);
            };
          });
        });
      } finally { try { db.close(); } catch (e) { /* ignore */ } }
    }
    rows.forEach(function (c) { if (!c.db) { try { if (localStorage.getItem(c.key) === c.value) localStorage.removeItem(c.key); } catch (e) { /* ignore */ } } });
  }
  async function pool(list, n, fn) {
    var next = 0, firstErr = null;
    async function worker() { while (!firstErr) { var i = next++; if (i >= list.length) return; try { await fn(list[i], i); } catch (e) { if (!firstErr) firstErr = e; } } }
    var ws = []; for (var k = 0; k < Math.min(n, list.length); k++) ws.push(worker());
    await Promise.all(ws);
    if (firstErr) throw firstErr;
  }

  // ------------------------------------------------------------------------------------------------------------
  // 11. WDS.connect(): the store API
  // ------------------------------------------------------------------------------------------------------------
  function isInternalName(name) { return typeof name === 'string' && name.indexOf(INTERNAL_PREFIX) === 0; }
  function checkAppName(name) {
    if (typeof name !== 'string' || name.length === 0) throw new Err.UsageError('record name must be a non-empty string');
    if (isInternalName(name)) throw new Err.UsageError('record names starting with "' + INTERNAL_PREFIX + '" are reserved for the library');
    return name;
  }
  async function snapshotValue(value) { // detached copy for backups: JSON text round trip, Blobs to bytes
    if (typeof Blob !== 'undefined' && value instanceof Blob) return { kind: 'bytes', mime: value.type || undefined, value: new Uint8Array(await value.arrayBuffer()) };
    if (value instanceof ArrayBuffer) return { kind: 'bytes', value: new Uint8Array(value.slice(0)) };
    if (ArrayBuffer.isView(value)) return { kind: 'bytes', value: new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)) };
    var text = JSON.stringify(value);
    return { kind: 'json', value: text === undefined ? null : JSON.parse(text) };
  }

  // Collection index: applies pending operations to a copy of the items. Ops run in order; nothing depends on a clock. The order of the
  // items is the order of the keys: a new item goes to the end.
  function applyCollectionOps(items, ops) {
    var out = {};
    Object.keys(items).forEach(function (id) { out[id] = items[id]; });
    ops.forEach(function (op) {
      if (op.t === 'upsert') {
        var old = out[op.id];
        // An op that carries the version of the record it describes never replaces the entry of a newer version (a saved-later
        // title of another device is not overwritten by a delayed op of this one).
        if (old && old.v !== undefined && op.v !== undefined && op.v < old.v) return;
        var entry = { m: op.m || {} };
        var v = op.v !== undefined ? op.v : (old ? old.v : undefined);
        if (v !== undefined) entry.v = v;
        out[op.id] = entry;
      }
      else if (op.t === 'remove') delete out[op.id];
    });
    return out;
  }

  function connect(opts) {
    opts = opts || {};
    // Deliberately few options: no injected fetch, storage or Argon2 function, so nothing in the API can see the passphrase.
    var client = new Core.Client({ scope: opts.scope, service: opts.baseUrl, escrowPins: opts.escrowPins, retiredEscrow: opts.retiredEscrow });
    var S = {
      client: client, info: null, sandboxWipe: null,
      get lang() { return detectLang(); },   // <html lang> decides, read at every use: the next dialog or notice after a change speaks the new language
      t: function (key, params) { return makeT(detectLang())(key, params); },
      now: function () { return Date.now(); },
      getInfo: function (force) { return client.getScopeInfo(force).then(function (i) { S.info = i; return i; }); },
      // What a dialog calls a record: the "title" of its entry in the list (a string, list loaded), else "this entry". Never the record name.
      label: function (name) {
        var title = null;
        collections.forEach(function (c) {
          var e = name.indexOf(c._prefix) === 0 ? c._entry(name.slice(c._prefix.length)) : null;
          if (e && e.m && typeof e.m.title === 'string' && e.m.title.trim()) title = e.m.title.trim().slice(0, 100);
        });
        return title ? '"' + title + '"' : S.t('common.thisEntry');
      },
    };
    function t(key, params) { return S.t(key, params); }
    var unlockPromise = null, lockPromise = null, pending = new Map(), queues = new Map();
    var allHandles = new Set(), handlesByName = new Map();           // autosave handles that are alive
    var collections = new Set(), colByPrefix = new Map();
    var conflictHandler = null, changeHandler = null, labels = {}, seenRemote = {};
    var rekeyRunning = false, watchInstalled = false, lastCheck = 0, checking = false, unloadInstalled = false;
    var reloading = false, offlineShown = false, reauthing = false, integrityShown = false;
    // The version of each record that this page last read or wrote (a read of a record with unsaved edits does not count): the base of the next save.
    var seen = new Map();

    function notify(text, key) { showNotice({ text: text, key: key, lang: S.lang, label: t('common.notifications') }); }
    function storageGet(suffix) {
      try { return client.storage.getItem('wds:' + client.scope + ':' + client.status().accessId + ':' + suffix); } catch (e) { return null; }
    }
    function storageSet(suffix, v) {
      try { client.storage.setItem('wds:' + client.scope + ':' + client.status().accessId + ':' + suffix, v); } catch (e) { /* storage unavailable */ }
    }
    function logError(what, e) { if (typeof console !== 'undefined' && console.error) console.error('wds: ' + what + ': ' + ((e && e.message) || e)); }
    function canWrite() { var r = client.status().role; return r === 'owner' || r === 'write'; }
    // The page changed: names of records, remote = true when it was another device.
    function emitChange(names, remote) {
      var list = [];
      names.forEach(function (n) { if (list.indexOf(n) < 0) list.push(n); });
      if (!list.length || !changeHandler) return;
      try { changeHandler({ names: list, remote: !!remote }); } catch (e) { logError('onChange handler failed', e); }
    }

    // ---- errors, and the end of a session ----
    // The session is over, the page starts again: locking, a revoked access, an emptied sandbox, a different vault.
    // The page is emptied first: Firefox would put typed text back into the fields of a reloaded page.
    function reloadNow() {
      reloading = true; document.documentElement.removeAttribute('data-wds-role');
      try { document.body.replaceChildren(); location.reload(); } catch (e) { /* no page to reload */ }
    }
    // The nightly wipe of a sandbox: an auth failure or an unknown vault after the wipe time means the vault is gone.
    function sandboxWiped(e) {
      if (!isSandbox(S) || !S.sandboxWipe || Date.now() / 1000 < S.sandboxWipe) return false;
      return !!e && ((e instanceof Err.AuthError && e.code !== 'forbidden') || e.status === 404);
    }
    function reportError(e) {
      if (sandboxWiped(e)) reloadNow();
      else if (e instanceof Err.OfflineError) offlineDialog();
      else if (e instanceof Err.QuotaError) notify(t('note.quota', { message: e.message }), 'quota');
      else if (e instanceof Err.AuthError && e.code === 'revoked') lockSession('revoked');
      else if (e instanceof Err.AuthError && e.status === 401) reauth();
      else if (e instanceof Err.AuthError && e.code === 'forbidden') notify(t('note.forbidden'), 'forbidden');
      else if (e instanceof Err.IntegrityError) integrityNotice(e);
      else if (e instanceof Err.VersionError) notify(t('note.version', { message: e.message }), 'version');
    }
    // A failed security check (tampered or rolled-back data) is not a line that disappears: one dialog with OK, once per page; the page goes on.
    function integrityNotice(e) {
      if (integrityShown) return;
      integrityShown = true;
      okNotice(t('integrity.title'), explainError(S, e));
    }
    function okNotice(title, text) {
      return noticeDialog(title, function (dlg) {
        return el('div', null, [el('p', { text: text }), el('div', { class: 'wds-actions' }, [btn(t('end.ok'), { primary: true, wds: 'notice-ok', onClick: function () { dlg.close(); } })])]);
      });
    }
    async function guarded(fn) {
      try { return await fn(); } catch (e) {
        reportError(e);
        throw e;
      }
    }

    // ---- unsaved values: the backup, the dialogs that offer it ----
    function unsavedCount() {
      var n = pending.size;
      allHandles.forEach(function (h) { if (h._i.dirty()) n++; });
      collections.forEach(function (c) { if (c._hasOps(true)) n++; });
      return n;
    }
    async function downloadBackup() {
      var unsaved = new Map(pending), recs = [], when = S.now();
      var live = Array.from(allHandles);
      for (var i = 0; i < live.length; i++) {
        var state = live[i]._i.state();
        if (state !== undefined) { try { var snap = await snapshotValue(state); unsaved.set(live[i]._i.name, { kind: snap.kind, mime: snap.mime, value: snap.value, time: when }); } catch (e) { /* not backed up */ } }
      }
      unsaved.forEach(function (v, name) { recs.push({ name: name, dir: 'unsaved', kind: v.kind, mime: v.mime, value: v.value, time: v.time }); });
      collections.forEach(function (c) { if (c._hasOps(true)) recs.push({ name: c._indexName, dir: 'unsaved', kind: 'json', value: c._indexValue(), time: when }); });
      if (!recs.length) { notify(t('note.backup.none'), 'backup'); return false; }
      if (recs.length === 1 && recs[0].dir === 'unsaved') {
        var r = recs[0];
        downloadBlob(new Blob([recordBytes(r)], { type: r.kind === 'json' ? 'application/json' : (r.mime || 'application/octet-stream') }), markedName(r.name, 'unsaved', r.kind));
        return true;
      }
      var arc = buildArchive(recs.map(function (r) { return { name: r.dir + '/' + r.name, kind: r.kind, mime: r.mime, value: r.value, time: r.time }; }),
        { scope: client.scope, service: client.service, exported: new Date().toISOString(), note: 'backup after a failed save; unsaved/ holds values that could not be saved' });
      downloadBlob(arc.blob, client.scope + '-backup.zip');
      return true;
    }
    // A dialog that needs an answer and ends the session: the backup (when something is unsaved) and one button; then the page reloads.
    function endDialog(view, titleKey, textKey, okKey) {
      return new Promise(function (resolve) {
        closeAllDialogs();
        var dlg = dialogFor(S, { title: t(titleKey), view: view, onClose: function () { resolve(); } }), unsaved = unsavedCount() > 0;
        append(dlg.body, [
          el('p', { text: t(textKey) }),
          el('div', { class: 'wds-actions' }, [
            unsaved ? btn(t('note.backup'), { wds: 'backup', onClick: downloadBackup }) : null,
            btn(t(okKey), { primary: true, wds: 'end-ok', onClick: function () { dlg.close(); } }),
          ]),
          el('p', { class: 'wds-hint', text: t('end.reload') }),
        ]);
        dlg.focusFirst();
      });
    }
    // Shown once per offline episode, only when something is unsaved. The page stays as it is: back up, or try again.
    function offlineDialog() {
      if (offlineShown || reloading || !unsavedCount()) return;
      offlineShown = true;
      var dlg = dialogFor(S, { title: t('offline.title'), view: 'offline', cancelable: true, closeLabel: t('common.close') });
      append(dlg.body, [
        el('p', { text: t('note.offline') }),
        el('div', { class: 'wds-actions' }, [
          btn(t('common.retry'), { primary: true, wds: 'offline-retry', onClick: function () { dlg.close(); retryAll(); } }),
          btn(t('note.backup'), { wds: 'backup', onClick: downloadBackup }),
        ]),
      ]);
      dlg.focusFirst();
    }

    // ---- per-name write queue ----
    function enqueue(name, fn) {
      var prev = queues.get(name) || Promise.resolve();
      var p = prev.then(fn);
      var tail = p.then(function () {}, function () {});
      queues.set(name, tail);
      tail.then(function () { if (queues.get(name) === tail) queues.delete(name); });
      return p;
    }
    async function ensureUnlocked() {
      if (unlockPromise) await unlockPromise;
      if (!client.status().unlocked) await doUnlock();
    }

    // ---- conflicts: the handler of the app (store.onConflict), else the dialog ----
    // err: the core's ConflictError. Resolves { type: 'mine' | 'theirs' } or { type: 'merged', value }.
    function decide(err, name) {
      var m = err.mine || {};
      var c = { name: name, mine: { value: m.value, kind: m.kind, mime: m.mime, deleted: !!m.deleted }, theirs: err.theirs ? Object.assign({}, err.theirs) : null };
      function viaDialog() { return conflictDialog(S, c).then(function (which) { return { type: which }; }); }
      var chosen = conflictHandler ? new Promise(function (resolve) { resolve(conflictHandler(c)); }).then(function (ret) {
        if (ret === 'mine' || ret === 'theirs') return { type: ret };
        if (ret && typeof ret === 'object' && 'merged' in ret) {
          if (c.mine.deleted) { logError('conflict handler for "' + name + '"', new Error('{ merged } does not apply to a delete; the dialog decides')); return null; }
          return { type: 'merged', value: ret.merged };
        }
        return null;
      }).catch(function (e) { logError('conflict handler for "' + name + '" failed, the dialog decides', e); return null; }) : Promise.resolve(null);
      return chosen.then(function (ch) { return ch || viaDialog(); });
    }

    // info (optional, filled in): {theirsDeleted}. A conflict whose "theirs" is the very value that is being written is no conflict: a write
    // whose answer was lost, or a rerun of a migration, meets its own earlier write.
    async function writeRecord(name, value, o, info) {
      var resolution = 'saved', lastErr = null;
      for (var round = 0; round < 4; round++) {
        try {
          var po = {};
          if (o && o.mime) po.mime = o.mime;
          // First attempt: against the version this page saw (create-only for a migration). Later rounds use what the conflict just taught the core.
          if (round === 0) { if (o && o.createOnly) po.base = null; else if (seen.has(name)) po.base = seen.get(name); }
          var r = await client.put(name, value, po);
          pending.delete(name); offlineShown = false; seen.set(name, r.version);
          var out = { name: name, version: r.version, size: r.size, resolution: resolution };
          if (resolution === 'merged') out.value = value;
          return out;
        } catch (e) {
          if (!(e instanceof Err.ConflictError)) {
            if (e instanceof Err.OfflineError) {
              try { var snap = await snapshotValue(value); pending.set(name, { kind: snap.kind, mime: (o && o.mime) || snap.mime, value: snap.value, time: S.now() }); } catch (e2) { /* not backed up */ }
            }
            throw e;
          }
          lastErr = e;
          var th = e.theirs;
          if (info) info.theirsDeleted = !!(th && th.deleted);
          if (th && !th.deleted && e.mine && e.mine.kind === th.kind && (th.kind === 'json' ? sameJson(th.value, e.mine.value) : await bytesEqual(th.value, e.mine.value))) {
            seen.set(name, th.version);
            return { name: name, version: th.version, resolution: 'saved' };
          }
          var d = await decide(e, name);
          if (d.type === 'theirs') {
            if (th && !(o && o.autosave)) seen.set(name, th.version);   // a button save hands the value to the app; an autosave does not: the editor is stale until it reloads
            return { name: name, version: th ? th.version : null, resolution: 'theirs', deleted: !!(th && th.deleted), value: th && !th.deleted ? th.value : undefined };
          }
          if (d.type === 'merged') { value = d.value; resolution = 'merged'; } else resolution = 'mine';
        }
      }
      throw lastErr;
    }
    function setRecord(name, value, o, info) {
      return enqueue(name, async function () { await ensureUnlocked(); return guarded(function () { return writeRecord(name, value, o, info); }); });
    }
    async function removeRecord(name) {
      var mineChosen = false, lastErr = null;
      for (var round = 0; round < 4; round++) {
        try {
          var done = await client.delete(name);
          pending.delete(name); seen.delete(name);
          return { name: name, deleted: done, resolution: !done ? 'absent' : mineChosen ? 'mine' : 'deleted' };
        } catch (e) {
          if (!(e instanceof Err.ConflictError)) throw e;
          lastErr = e;
          if (!e.theirs || e.theirs.deleted) return { name: name, deleted: false, resolution: 'absent' };
          var d = await decide(e, name);
          if (d.type === 'theirs') { seen.set(name, e.theirs.version); return { name: name, deleted: false, resolution: 'theirs', value: e.theirs.value }; }
          mineChosen = true;
        }
      }
      throw lastErr || new Err.ConflictError('could not delete "' + name + '" because it keeps changing', { code: 'precondition_failed', record: name });
    }
    // Removing a record stops the autosave handle of that name: there is nothing left to save.
    function removeNamed(name) {
      return enqueue(name, async function () {
        await ensureUnlocked();
        var h = handlesByName.get(name);
        if (h) h.stop();
        return guarded(function () { return removeRecord(name); });
      });
    }
    async function readValue(name) {
      var r = await guarded(function () { return client.getRecord(name, { fresh: true }); }), h = handlesByName.get(name);
      if (!r) { seen.delete(name); return undefined; }
      if (!(h && h._i.dirty())) seen.set(name, r.version);   // a re-read while the editor holds unsaved text keeps the old base: the next save is a conflict

      return r.kind === 'bytes' ? new Blob([r.value], { type: r.mime || 'application/octet-stream' }) : r.value;
    }
    async function readMany(names) {
      var out = new Array(names.length);
      await pool(names, 6, async function (name, i) { out[i] = await readValue(name); });
      return out;
    }

    // ---- autosave ----
    // hooks (collections): prepare(state) -> ctx (may throw, nothing is written then), afterSave(result, ctx) -> promise.
    function makeAutosave(name, getState, o, hooks) {
      o = o || {};
      if (typeof getState !== 'function') throw new Err.UsageError('autosave needs a function that returns the state');
      if (handlesByName.has(name)) throw new Err.UsageError('autosave: "' + name + '" already has a live autosave handle; keep one handle per record (stop() ends it)', { code: 'duplicate_handle' });
      var delay = o.delayMs === undefined ? 2000 : o.delayMs;
      var timer = null, dirty = false, running = null, status = 'idle', prevClean = 'idle', failures = 0, stopped = false, handle;
      function setStatus(s, info) {
        status = s;
        if (o.onStatus) { try { o.onStatus(s, info); } catch (e) { logError('onStatus failed', e); } }
      }
      function schedule(ms) { if (stopped) return; clearTimeout(timer); timer = setTimeout(run, ms === undefined ? delay : ms); }
      function run() {
        clearTimeout(timer); timer = null;
        if (stopped || reloading || running || !dirty) return running || Promise.resolve();
        if (!client.status().unlocked) { setStatus('error', { error: new Err.UsageError('locked: unlock the vault first', { code: 'locked' }) }); return Promise.resolve(); }
        dirty = false;
        var state, ctx, lost = false;
        try { state = getState(); if (state !== undefined && hooks && hooks.prepare) ctx = hooks.prepare(state); } catch (e) { dirty = true; setStatus('error', { error: e }); return Promise.resolve(); }
        if (state === undefined) { setStatus(prevClean); return Promise.resolve(); }   // nothing to save right now
        setStatus('saving');
        running = enqueue(name, function () { return guarded(function () { return writeRecord(name, state, { mime: o.mime, autosave: true }); }); }).then(function (res) {
          failures = 0;
          lost = res.resolution === 'theirs' || res.resolution === 'merged';   // the vault holds another text than the editor: the app learns it from onChange
          setStatus(dirty ? 'dirty' : 'saved');
          return hooks && hooks.afterSave ? Promise.resolve(hooks.afterSave(res, ctx)).catch(function (e) { logError('the list entry of "' + name + '" is not updated yet', e); }) : null;
        }).then(function () { emitChange([name], lost); }, function (err) {
          dirty = true; setStatus('error', { error: err });
          if (err instanceof Err.OfflineError) { failures++; schedule(Math.min(60000, 5000 * failures)); }
        }).then(function () { running = null; if (dirty && status !== 'error') schedule(); });
        return running;
      }
      async function flush() {
        try {
          for (var i = 0; i < 5; i++) {
            if (running) await running;
            if (!dirty || stopped) return status;
            await run();
            if (status === 'error') return status;
          }
        } catch (e) { /* flush never rejects */ }
        return status;
      }
      handle = {
        changed: function () {
          if (stopped) return;
          dirty = true;
          if (status !== 'saving' && status !== 'dirty') prevClean = status;
          if (status !== 'saving') setStatus('dirty');
          if (!running) schedule();
        },
        flush: flush,
        stop: function () {
          if (stopped) return;
          stopped = true; clearTimeout(timer); timer = null;
          allHandles.delete(handle);
          if (handlesByName.get(name) === handle) handlesByName.delete(name);
        },
      };
      Object.defineProperty(handle, '_i', { value: {
        name: name,
        dirty: function () { return !stopped && (dirty || !!running); },
        state: function () { if (stopped || !dirty) return undefined; try { return getState(); } catch (e) { return undefined; } },   // for the backup
        retry: function () { if (dirty && !running && !stopped) schedule(0); },
      } });
      allHandles.add(handle); handlesByName.set(name, handle);
      installUnloadGuards();
      return handle;
    }
    function flushAll(ms) {
      var work = Promise.all(Array.from(allHandles).map(function (h) { return h.flush(); }).concat(Array.from(collections).map(function (c) { return c._flush(); })));
      return Promise.race([work, new Promise(function (resolve) { setTimeout(resolve, ms); })]);
    }
    function retryAll() {
      allHandles.forEach(function (h) { h._i.retry(); });
      collections.forEach(function (c) { c._retry(); });
    }

    // ---- lock = reload ----
    // Lock, a revoked access: save what is pending (up to 8 s), offer the backup of what could not be saved, then reload the page, so that
    // no data of the vault stays in it.
    function lockSession(reason) {
      if (lockPromise) return lockPromise;
      lockPromise = (async function () {
        try {
          if (reason === 'user' && client.status().unlocked) await flushAll(8000);
          client.lock();
          document.documentElement.removeAttribute('data-wds-role');
          if (reason === 'revoked') await endDialog('revoked', 'end.revoked.title', 'note.revoked', 'end.ok');
          else if (unsavedCount() > 0) await endDialog('lock-unsaved', 'end.lock.title', 'end.lock.text', 'end.lock.anyway');
        } catch (e) { logError('lock failed', e); }
        reloadNow();
      })();
      return lockPromise;
    }
    // The session ended (the passphrase was changed elsewhere): the unlock dialog opens above the page, which stays as it is. Same vault: pending
    // writes go on from memory. Another vault, or cancelling: the page reloads.
    async function reauth() {
      if (reauthing || reloading || lockPromise) return;
      reauthing = true;
      var vault = client.status().vaultId;
      client.lock();
      document.documentElement.removeAttribute('data-wds-role');
      try {
        await doUnlock({ cancelable: true });
        if (client.status().vaultId === vault) { retryAll(); reauthing = false; return; }
      } catch (e) { /* cancelled */ }
      await lockSession('session');   // cancelled, or another vault: the end of the lock button (backup offer when something is unsaved), then the reload
      reauthing = false;
    }

    // ---- collections ----
    function makeCollection(prefix, options) {
      options = options || {};
      if (options.meta !== undefined && typeof options.meta !== 'function') throw new Err.UsageError('collection: meta must be a function (value, id) => object');
      var col = { _prefix: prefix, _indexName: prefix.slice(0, -1) + '.index' }, metaFn = options.meta;   // the public object has no prefix or indexName
      checkAppName(col._indexName);
      var loaded = false, base = null, ops = [], writing = null, failed = false, lastWrite = 0, debounceTimer = null, loading = null, warnedBig = false, gate = Promise.resolve();
      // Reads and writes of the index take turns: a read that was sent before a write must not come back after it (the core would see
      // an older version than the write it just made).
      function exclusive(fn) { var p = gate.then(fn, fn); gate = p.then(function () {}, function () {}); return p; }
      function isStrict(op) { return !op.lazy; }
      function isReady(op) { return !op.lazy && !(op.wait > Date.now()); }   // an op of an autosave waits for its 10 s window, unless something else is written anyway
      function checkId(id) {
        if (typeof id !== 'string' || id.length < 1 || id.length > 200 || id.indexOf('/') >= 0) throw new Err.UsageError('collection: an id is 1 to 200 characters without "/"');
        return id;
      }
      function newId() {
        var b = new Uint8Array(10), s = '', chars = '0123456789abcdefghijklmnopqrstuvwxyz';
        crypto.getRandomValues(b);
        for (var i = 0; i < 10; i++) s += chars[b[i] % 36];
        return s;
      }
      function metaFor(value, id, explicit) {
        var m = explicit !== undefined ? explicit : (metaFn ? metaFn(value, id) : undefined);
        if (m === undefined || m === null) return {};
        if (typeof m !== 'object' || Array.isArray(m)) throw new Err.UsageError('collection: meta must be a plain object');
        var text = JSON.stringify(m);
        if (utf8(text).length > 512) throw new Err.UsageError('collection: the meta of "' + id + '" is larger than 512 bytes; keep only what a list needs');
        return JSON.parse(text);
      }
      function parseIndex(v) {
        if (!v || typeof v !== 'object' || v.wds !== 'collection/1' || !v.items || typeof v.items !== 'object' || Array.isArray(v.items)) {
          throw new Err.UsageError('the record "' + col._indexName + '" is not a collection index', { code: 'bad_index' });
        }
        var out = {};
        Object.keys(v.items).forEach(function (id) {
          var e = v.items[id];
          if (e && typeof e === 'object') {
            out[id] = { m: e.m && typeof e.m === 'object' && !Array.isArray(e.m) ? e.m : {} };
            if (Number.isInteger(e.v) && e.v >= 0) out[id].v = e.v;   // version of the record this entry describes
          }
        });
        return out;
      }
      function view() { return base ? applyCollectionOps(base.items, ops) : {}; }
      function listOf(items) { return Object.keys(items).map(function (id) { return { id: id, name: prefix + id, meta: items[id].m }; }); }
      async function readBase() {
        var r = await guarded(function () { return client.getRecord(col._indexName, { fresh: true }); });
        // A read that was slower than a write of this page returns an older version: it must not replace the newer base.
        if (r && base && base.version !== undefined && r.version < base.version) { loaded = true; return; }
        base = r ? { version: r.version, items: parseIndex(r.value) } : { version: undefined, items: {} };
        loaded = true;
      }
      async function writeBatch(batch) {
        var lastErr = null;
        if (!base) await readBase();
        for (var round = 0; round < 10; round++) {
          var items = applyCollectionOps(base.items, batch);
          var value = { wds: 'collection/1', items: items };
          if (!warnedBig && JSON.stringify(value).length > 262144) { warnedBig = true; if (typeof console !== 'undefined' && console.warn) console.warn('wds: the index "' + col._indexName + '" is larger than 256 KB; split the collection (by year or project) or keep meta smaller'); }
          try {
            // base null = the index must not exist yet (If-None-Match); never fall back to what the client happens to know
            var r = await guarded(function () { return client.put(col._indexName, value, { base: base.version === undefined ? null : base.version }); });
            base = { version: r.version, items: items };
            lastWrite = Date.now(); failed = false;
            ops = ops.filter(function (op) { return batch.indexOf(op) < 0; });
            return;
          } catch (e) {
            if (!(e instanceof Err.ConflictError)) throw e;
            lastErr = e;
            var th = e.theirs;   // theirs is the new base; the pending changes are replayed on it
            var prev = base.items;
            base = th && !th.deleted ? { version: th.version, items: parseIndex(th.value) } : { version: th ? th.version : undefined, items: {} };
            // What another device added or changed in the list becomes visible here with this merge: tell the app (remote: true).
            var mine = {}, merged = [];
            batch.forEach(function (op) { mine[op.id] = true; });
            Object.keys(base.items).forEach(function (id) { if (!mine[id] && (!prev[id] || !sameJson(prev[id].m, base.items[id].m))) merged.push(prefix + id); });
            Object.keys(prev).forEach(function (id) { if (!mine[id] && !base.items[id]) merged.push(prefix + id); });
            if (merged.length) emitChange(merged, true);
            if (round < 9) await sleep(50 + Math.floor(Math.random() * 450));
          }
        }
        throw lastErr;
      }
      // A failed index write is not an error of the call that caused it: the changes stay queued and go out with the next write, on focus, when
      // the connection is back, and before the page is locked or closed.
      async function pump() {
        while (!reloading && ops.some(isReady)) {
          var batch = ops.slice();
          try { await exclusive(function () { return writeBatch(batch); }); } catch (e) { failed = true; return; }
        }
      }
      function kick(force) {
        clearTimeout(debounceTimer); debounceTimer = null;
        if (force) ops.forEach(function (op) { op.wait = 0; });
        if (!writing) writing = pump().then(function () { writing = null; }, function () { writing = null; });
        return writing;
      }
      // o: {lazy: waits for the next write that happens anyway, debounced: at most one write of its own per 10 s}
      function queueOp(op, o) {
        o = o || {};
        op.lazy = !!o.lazy;
        if (o.debounced) op.wait = lastWrite + 10000;
        ops.push(op);
        if (op.lazy) return;
        if (op.wait > Date.now()) { if (!debounceTimer) debounceTimer = setTimeout(kick, op.wait - Date.now()); }
        else kick();
      }
      function upsertOp(id, meta, v) { var op = { t: 'upsert', id: id, m: meta }; if (Number.isInteger(v)) op.v = v; return op; }
      // What the collection does after an item was written (or turned out to be gone).
      function afterEntity(id, res, info, meta, explicitMeta, o) {
        var mem = view()[id], force = info && info.theirsDeleted;
        if (res.resolution === 'theirs') {
          if (res.deleted) { if (canWrite() && mem) queueOp({ t: 'remove', id: id }, { lazy: true }); return; }
          var tm; try { tm = metaFor(res.value, id, undefined); } catch (e) { tm = null; }
          if (tm && (!mem || !sameJson(mem.m, tm))) queueOp(upsertOp(id, tm, res.version), o);
          return;
        }
        var m = res.resolution === 'merged' && explicitMeta === undefined ? metaFor(res.value, id, undefined) : meta;
        if (force || !mem || !sameJson(mem.m, m)) queueOp(upsertOp(id, m, res.version), o);
      }
      async function loadNow() {
        if (loaded) return;
        if (!loading) loading = exclusive(readBase).then(function () { loading = null; }, function (e) { loading = null; throw e; });
        await loading;
      }
      async function softLoad() { try { await ensureUnlocked(); await loadNow(); } catch (e) { /* the index is repaired by the next write */ } }
      function needLoaded() { if (!loaded) throw new Err.UsageError('call await ' + prefix.slice(0, -1) + '.load() first: the list of "' + prefix + '" is not loaded'); }
      // The item record, then its list entry (queued: the call does not wait for the index write).
      async function writeItem(id, value, o) {
        o = o || {};
        var name = prefix + id;
        checkAppName(name);
        var meta = metaFor(value, id, o.meta);
        await softLoad();
        var info = {};
        var res = await setRecord(name, value, { mime: o.mime, createOnly: o.createOnly }, info);
        afterEntity(id, res, info, meta, o.meta);
        return res;
      }

      col.load = async function () { await ensureUnlocked(); await loadNow(); return listOf(view()); };
      col.items = function () { needLoaded(); return listOf(view()); };
      col.get = async function (id) {
        checkId(id);
        await ensureUnlocked();
        var v = await readValue(prefix + id);
        if (v === undefined && loaded && canWrite() && view()[id]) queueOp({ t: 'remove', id: id }, { lazy: true });
        return v;
      };
      col.getAll = async function () {
        await col.load();
        var list = listOf(view()), vals = await readMany(list.map(function (e) { return e.name; })), out = [];
        list.forEach(function (e, i) {
          if (vals[i] === undefined) { if (canWrite()) queueOp({ t: 'remove', id: e.id }, { lazy: true }); return; }
          out.push({ id: e.id, name: e.name, meta: e.meta, value: vals[i] });
        });
        return out;
      };
      col.add = async function (value, o) {
        var id = newId(), res = await writeItem(id, value, o);
        emitChange([prefix + id], false);
        return { id: id, name: prefix + id, version: res.version, resolution: res.resolution };
      };
      col.set = async function (id, value, o) {
        checkId(id);
        var res = await writeItem(id, value, o);
        emitChange([prefix + id], false);
        return res;
      };
      col.remove = async function (id) {
        checkId(id);
        await softLoad();
        var res = await removeNamed(prefix + id), mem = view()[id];
        if (res.resolution === 'deleted' || res.resolution === 'absent' || res.resolution === 'mine') {
          if (mem || res.resolution !== 'absent') queueOp({ t: 'remove', id: id });
        } else if (res.resolution === 'theirs') {
          var tm; try { tm = metaFor(res.value, id, undefined); } catch (e) { tm = null; }
          if (tm && (!mem || !sameJson(mem.m, tm))) queueOp(upsertOp(id, tm));
        }
        emitChange([prefix + id], false);
        return res;
      };
      col.autosave = function (id, getState, o) {
        checkId(id); o = o || {};
        return makeAutosave(prefix + id, getState, o, {
          prepare: function (state) { return metaFor(state, id, o.meta); },
          // meta changes of an autosave are written at most every 10 s (and on lock and pagehide)
          afterSave: function (res, meta) { return softLoad().then(function () { afterEntity(id, res, {}, meta, o.meta, { debounced: true }); }); },
        });
      };

      // ---- internals for the store ----
      col._write = writeItem;   // migrateLocal: the item and its list entry, without the change event
      col._entry = function (id) { return loaded ? view()[id] : undefined; };
      col._has = function (id) { return loaded && !!view()[id]; };
      col._loaded = function () { return loaded; };
      col._hasOps = function (strict) { return ops.some(function (op) { return !strict || !op.lazy; }); };
      col._indexValue = function () { return { wds: 'collection/1', items: view() }; };
      // Resolves true when every change that waits for the index is on the server (never rejects; the changes stay queued otherwise).
      col._flush = async function () {
        if (canWrite() && ops.some(isStrict)) await kick(true);
        return !ops.some(isStrict);
      };
      col._flushNow = function () { if (canWrite() && ops.some(isStrict)) kick(true); };
      col._retry = function () { if (failed && canWrite() && ops.some(isStrict)) kick(); };
      // The remote check: reads the index again; the item names that differ now.
      col._refresh = async function () {
        if (!loaded) return [];
        if (writing) await writing;
        var before = null;
        await exclusive(function () { before = view(); return readBase(); });
        var after = view(), names = [];
        Object.keys(after).forEach(function (id) { if (!before[id] || !sameJson(before[id].m, after[id].m)) names.push(prefix + id); });
        Object.keys(before).forEach(function (id) { if (!after[id]) names.push(prefix + id); });
        return names;
      };
      // rows: list() result of the whole vault. Records under the prefix that the index does not know are queued as upserts (the repair at export).
      col._orphans = function (rows) {
        if (!loaded || !canWrite()) return;
        var mem = view();
        rows.forEach(function (r) {
          if (r.name.indexOf(prefix) !== 0) return;
          var id = r.name.slice(prefix.length);
          if (!id || id.indexOf('/') >= 0 || id.length > 200 || mem[id]) return;
          queueOp(upsertOp(id, {}, r.version));   // without meta: it is filled in when the item is saved again
        });
      };
      return col;
    }

    // ---- store.migrateLocal: take over what an earlier, local-only version left in this browser ----
    var migrateRuns = {};
    function migrateTag(id) {   // the one write to the old storage besides the delete: a random tag of this browser (it makes the ids of several browsers differ)
      var key = 'wds:migrate:' + id + ':tag', tag = null;
      try { tag = localStorage.getItem(key); } catch (e) { tag = null; }
      if (tag && /^[0-9a-f]{8}$/.test(tag)) return tag;
      tag = hexLower(crypto.getRandomValues(new Uint8Array(4)));
      try { localStorage.setItem(key, tag); } catch (e) { throw MigrateStop('could not write the tag of this browser to localStorage (full or disabled)'); }
      return tag;
    }
    // One dialog for the whole run: the question, the progress, a failure.
    function migrateShow(run, view, build, cancelable) {
      if (!run.dlg || run.dlg.closed) run.dlg = dialogFor(S, { title: t('migrate.title'), view: 'progress', cancelable: true, closeLabel: t('common.close'), onClose: function () { var f = run.onClose; run.onClose = null; if (f) f(); } });
      clear(run.dlg.body); append(run.dlg.body, build());
      run.dlg.setCancelable(!!cancelable); run.dlg.setView(view); run.dlg.focusFirst();
      return run.dlg;
    }
    function closeRun(run) { run.onClose = null; if (run.dlg && !run.dlg.closed) run.dlg.close(); }
    function migrateBackupLink(cfg, err) {   // the copy is made from a fresh read: the old data as it is now
      return el('p', null, linkBtn(t('migrate.backup'), function () {
        migrateRead(cfg).then(function (rows) { return migrateBackupBlob(cfg, rows); }).then(function (zip) { downloadBlob(zip, cfg.id + '-old-data-' + new Date().toISOString().slice(0, 10) + '.zip'); err.textContent = ''; },
          function (e) { logError('backup failed', e); err.textContent = t('migrate.backup.failed', { why: (e && e.message) || String(e) }); });
      }, 'migrate-backup'));
    }
    function migrateProgress(run, key, total) {
      var bar = el('progress', { class: 'wds-progress', 'aria-label': t('migrate.title'), max: total || 1, value: 0 }), line = el('p', { role: 'status', 'aria-live': 'polite', text: t(key, { done: 0, total: total }) });
      migrateShow(run, 'progress', function () { return [bar, line]; }, false);
      return function (done) { bar.value = done; line.textContent = t(key, { done: done, total: total }); };
    }
    // One question, with the link to the copy of the old data: resolves 'yes' or 'no'.
    function migrateAsk(run, cfg, view, text, yesLabel, yesWds) {
      return new Promise(function (resolve) {
        run.onClose = function () { resolve('no'); };
        var err = el('div', { 'data-wds': 'form-error', 'aria-live': 'polite' });
        migrateShow(run, view, function () {
          return [err, el('p', { text: text }), migrateBackupLink(cfg, err),
            el('div', { class: 'wds-actions' }, [btn(yesLabel, { primary: true, wds: yesWds, onClick: function () { run.onClose = null; resolve('yes'); } }), btn(t('migrate.no'), { wds: 'migrate-no', onClick: function () { run.dlg.close(); } })])];
        }, true);
      });
    }
    // Two steps, on two starts: this run only copies. The old rows stay until the person has seen the copy in the app and confirms at the next start.
    async function migrateBody(cfg, run) {
      var rows = await migrateRead(cfg), marker = 'migrated-' + cfg.id;
      if (!rows.length) return { status: 'nothing' };
      await ensureUnlocked();
      var sandbox = isSandbox(S);
      if (client.status().role !== 'owner') {   // the old data can only go into a vault of the person's own
        if (typeof console !== 'undefined' && console.warn) console.warn('wds: migrateLocal "' + cfg.id + '": this browser holds old data; only an owner can take it over, so it stays here');
        return { status: 'declined', why: 'not-owner' };
      }
      var copied = null;
      try { copied = JSON.parse(storageGet(marker) || 'null'); } catch (e) { copied = null; }
      if (Array.isArray(copied)) {   // an earlier start copied these rows: ask whether to delete them (never in the sandbox)
        if (sandbox) return { status: 'nothing' };
        var left = [];
        for (var h = 0; h < rows.length; h++) { rows[h].fp = migrateRowFp(rows[h]); if (copied.indexOf(await migrateRowHash(rows[h])) >= 0) left.push(rows[h]); }
        if (left.length) {
          if (await migrateAsk(run, cfg, 'migrate-delete', t('migrate.cleanup', { count: left.length }), t('migrate.delete'), 'migrate-delete-yes') !== 'yes') { closeRun(run); return { status: 'nothing' }; }
          await migrateDelete(left);
          storageSet(marker, '');
          closeRun(run);
          notify(t('migrate.deleted', { n: left.length }), 'migration');
          return { status: 'nothing' };
        }
        storageSet(marker, '');   // none of the copied rows is left (or they changed): the rows that are there are asked about afresh
      }
      // ---- map, once per row ----
      var tag = migrateTag(cfg.id), writes = [], claimed = [], names = {};
      for (var i = 0; i < rows.length; i++) {
        var r = rows[i], before = writes.length, ret;
        r.id = migrateRowId(tag, r.source, r.key); r.fp = migrateRowFp(r);
        var ref = function (row) { return function (key, source) { return migrateRowId(tag, source === undefined ? row.source : source, key); }; }(r);
        try { ret = await cfg.map({ source: r.source, key: r.key, value: r.value, id: r.id }, ref); }
        catch (e) { throw e && (e.isMigrateStop || e instanceof Err.UsageError) ? e : MigrateStop('map threw for ' + migrateRowLabel(r) + ': ' + ((e && e.message) || e)); }
        (ret === undefined || ret === null ? [] : Array.isArray(ret) ? ret : [ret]).forEach(function (w) {
          var where = 'map result for ' + migrateRowLabel(r);
          if (!w || typeof w !== 'object' || w.value === undefined || (w.collection === undefined) === (w.name === undefined)) throw new Err.UsageError(where + ' must be { collection: "notes/", id, value, meta? } or { name, value }');
          if (w.collection !== undefined && (typeof w.collection !== 'string' || w.collection.length < 2 || w.collection.slice(-1) !== '/' || typeof w.id !== 'string' || !w.id || w.id.length > 200 || w.id.indexOf('/') >= 0)) throw new Err.UsageError(where + ': collection ends with "/", id is 1 to 200 characters without "/"');
          var name = w.collection !== undefined ? w.collection + w.id : checkAppName(w.name);
          if (names[name]) throw MigrateStop('two writes would get the name "' + name + '" (' + migrateRowLabel(r) + ' and ' + names[name] + '); build ids with old.id or ref');
          names[name] = migrateRowLabel(r);
          var isFile = isBlobValue(w.value) || isBinaryValue(w.value);
          if (!isFile) migrateCheckJson(w.value, where, 0);
          writes.push({ name: name, prefix: w.collection, id: w.id, value: isFile ? w.value : JSON.parse(JSON.stringify(w.value)), meta: w.meta, mime: w.mime });
        });
        if (writes.length > before) claimed.push(r);   // the rows that produced writes: only these are ever deleted
      }
      if (!writes.length) return { status: 'nothing' };
      // ---- ask ----
      var vaultEnd = Core.displayCode(client.status().accessId).slice(-4);
      if (await migrateAsk(run, cfg, 'migrate', t(sandbox ? 'migrate.question.sandbox' : 'migrate.question', { count: writes.length, vault: vaultEnd }), t('migrate.yes'), 'migrate-yes') !== 'yes') { closeRun(run); return { status: 'declined' }; }
      // ---- copy (create-only: an existing different record is a conflict, answered by onConflict or the dialog) ----
      var done = 0, step = migrateProgress(run, 'migrate.progress', writes.length), cols = {};
      var prefixes = writes.map(function (w) { return w.prefix; }).filter(function (p, k, a) { return p && a.indexOf(p) === k; });
      for (var c = 0; c < prefixes.length; c++) { cols[prefixes[c]] = colByPrefix.get(prefixes[c]) || store.collection(prefixes[c]); await cols[prefixes[c]].load(); }
      await pool(writes, 4, async function (w) {
        var o = { meta: w.meta, mime: w.mime, createOnly: true };
        if (w.prefix) await cols[w.prefix]._write(w.id, w.value, o); else await setRecord(w.name, w.value, o);
        step(++done);
      });
      for (var f = 0; f < prefixes.length; f++) if (!(await cols[prefixes[f]]._flush())) throw MigrateStop('the list "' + prefixes[f] + '" could not be updated');
      emitChange(writes.map(function (w) { return w.name; }), false);
      var hashes = [];
      for (var q = 0; q < claimed.length; q++) hashes.push(await migrateRowHash(claimed[q]));
      storageSet(marker, JSON.stringify(hashes));
      closeRun(run);
      notify(t(sandbox ? 'migrate.done.sandbox' : 'migrate.done', { n: writes.length }), 'migration');
      return { status: 'migrated' };
    }
    function migrateWhy(e) {
      if (e && e.isMigrateStop) return e.why;
      if (e instanceof Err.OfflineError) return 'offline: ' + e.message;
      if (e instanceof Err.QuotaError) return 'quota: ' + e.message;
      if (e instanceof Err.AuthError) return 'locked: ' + e.message;
      if (typeof DOMException !== 'undefined' && e instanceof DOMException) return 'the old browser storage changed or could not be read while it was copied (' + (e.name || 'DOMException') + ')';
      return String((e && e.message) || e);
    }
    // Everything that map or the old data cause is a result { status: 'failed', why } (the developer's message goes to the console): a mistake in one
    // user's data must not stop the page from starting for that user. The person gets a dialog with the copy of the old data.
    async function migrateRun(cfg) {
      var run = { dlg: null, onClose: null };
      try { return await migrateBody(cfg, run); }
      catch (e) {
        var why = migrateWhy(e);
        if (typeof console !== 'undefined' && console.error) console.error('wds: migrateLocal "' + cfg.id + '" stopped: ' + why);
        if (/^locked/.test(why) || reloading) { closeRun(run); return { status: 'failed', why: why }; }
        var err = el('div', { 'data-wds': 'form-error', 'aria-live': 'polite' });
        migrateShow(run, 'migrate-failed', function () {
          return [err, el('p', { text: t('migrate.failed') }), migrateBackupLink(cfg, err), el('div', { class: 'wds-actions' }, [btn(t('common.close'), { primary: true, wds: 'migrate-close', onClick: function () { run.dlg.close(); } })])];
        }, true);
        return { status: 'failed', why: why };
      }
    }
    function migrateLocal(o) {
      var cfg;
      try { cfg = migrateParse(o); } catch (e) { return Promise.reject(e); }   // a wrong option rejects before anything is read
      if (!migrateRuns[cfg.id]) migrateRuns[cfg.id] = migrateRun(cfg);   // once per start
      return migrateRuns[cfg.id];
    }

    // ---- the API ----
    function doUnlock(o) {
      if (client.status().unlocked && !unlockPromise) return Promise.resolve(store.status());
      if (unlockPromise) return unlockPromise;
      unlockPromise = (async function () {
        try { var res = await runUnlock(S, o || {}); await afterUnlock(res); return store.status(); }
        finally { unlockPromise = null; }
      })();
      return unlockPromise;
    }
    var store = {
      unlock: function () { return doUnlock(); },
      status: function () { var st = client.status(); return { unlocked: st.unlocked, role: st.role, sandbox: isSandbox(S) }; },
      // Saves unsaved autosave edits and pending list changes first (up to 8 s), then reloads the page.
      lock: function () { return lockSession('user'); },
      // fn(c) -> 'mine' | 'theirs' | { merged: value } | undefined (the dialog decides). One handler (a second one is a UsageError); null removes it.
      onConflict: function (fn) {
        if (fn !== null && fn !== undefined && typeof fn !== 'function') throw new Err.UsageError('onConflict: a function, or null');
        if (fn && conflictHandler && fn !== conflictHandler) throw new Err.UsageError('onConflict: there is one handler per page and it is set already; route inside it, or call onConflict(null) first');
        conflictHandler = fn || null;
      },
      // fn({ names, remote }): after this page's own writes (remote: false), and when the vault holds something other than this page shows (remote: true). One handler; null removes it.
      onChange: function (fn) {
        if (fn !== null && fn !== undefined && typeof fn !== 'function') throw new Err.UsageError('onChange: a function, or null');
        if (fn && changeHandler && fn !== changeHandler) throw new Err.UsageError('onChange: there is one handler per page and it is set already; render the list and the open entry from the same handler, or call onChange(null) first');
        changeHandler = fn || null;
      },
      // A Blob (with the stored type) for a file, else the JSON value; undefined when the record does not exist. Asks the server every time.
      get: async function (name) {
        checkAppName(name);
        await ensureUnlocked();
        return readValue(name);
      },
      set: async function (name, value, o) {
        checkAppName(name);
        var res = await setRecord(name, value, o);
        emitChange([name], false);
        return res;
      },
      // -> { name, deleted, resolution: 'deleted' | 'absent' | 'mine' | 'theirs', value? }. The autosave handle of the name is stopped.
      remove: async function (name) {
        checkAppName(name);
        var res = await removeNamed(name);
        if (res.resolution !== 'absent') emitChange([name], false);
        return res;
      },
      showHistory: async function (name) {
        checkAppName(name);
        await ensureUnlocked();
        return historyDialog(S, name, {
          history: function (n) { return guarded(function () { return client.history(n); }); },
          getVersion: function (n, v) { return guarded(function () { return client.getVersion(n, v); }); },
          restore: function (n, v) {
            return enqueue(n, async function () { await ensureUnlocked(); var r = await guarded(function () { return client.restore(n, v); }); seen.set(n, r.version); emitChange([n], false); return r; });
          },
          role: function () { var st = client.status(); return st && st.role; },
        });
      },
      migrateLocal: migrateLocal,
      // Statuses: idle, dirty, saving, saved, error. One live handle per name.
      autosave: function (name, getState, o) { checkAppName(name); return makeAutosave(name, getState, o, null); },
      // A list of items "<prefix><id>" with an index record that several devices can extend without losing each other's items.
      collection: function (prefix, o) {
        if (typeof prefix !== 'string' || prefix.length < 2 || prefix.slice(-1) !== '/') throw new Err.UsageError('collection: the prefix must end with "/", for example "notes/"');
        if (isInternalName(prefix)) throw new Err.UsageError('collection: prefixes starting with "' + INTERNAL_PREFIX + '" are reserved for the library');
        var c = makeCollection(prefix, o);
        collections.add(c); colByPrefix.set(prefix, c);
        installUnloadGuards();
        return c;
      },
      // The vault dialog, for every role: members and invites (owner), own access, access sheet, passphrase, export, lock.
      openVault: async function () {
        await ensureUnlocked();
        if (client.status().role === 'owner') await loadLabels();
        return shareDialog(S, shareApi);
      },
    };

    // Everything of the vault in one ZIP (unencrypted); the list entries that are missing are repaired on the way.
    async function exportAll(onProgress) {
      await ensureUnlocked();
      return guarded(async function () {
        var names = (await client.list()).filter(function (r) { return !isInternalName(r.name); });
        collections.forEach(function (c) { c._orphans(names); });
        var recs = [];
        for (var i = 0; i < names.length; i++) {
          var r = await client.getRecord(names[i].name, { fresh: true });
          if (r) recs.push(r);
          if (onProgress) onProgress(i + 1, names.length);
        }
        var arc = buildArchive(recs, { scope: client.scope, service: client.service, exported: new Date().toISOString() });
        downloadBlob(arc.blob, client.scope + '-export.zip');
        return { count: recs.length, bytes: arc.blob.size };
      });
    }

    // ---- labels for members (stored encrypted inside the vault; owner only) ----
    async function loadLabels() {
      try {
        var r = await client.getRecord(LABELS_RECORD);
        labels = r && r.value && typeof r.value === 'object' && !Array.isArray(r.value) ? r.value : {};
      } catch (e) { labels = labels || {}; }
    }
    async function mutateLabels(fn) {
      for (var i = 0; i < 3; i++) {
        await loadLabels();
        var next = Object.assign({}, labels);
        fn(next);
        try { await client.put(LABELS_RECORD, next); labels = next; return; }
        catch (e) { if (!(e instanceof Err.ConflictError)) throw e; }
      }
    }
    function idList(suffix) { try { var v = JSON.parse(storageGet(suffix) || '[]'); return Array.isArray(v) ? v : []; } catch (e) { return []; } }
    function addIds(suffix, ids) {   // not secret: slot IDs that this device has seen or confirmed
      var cur = idList(suffix), n = cur.length;
      ids.forEach(function (id) { if (cur.indexOf(id) < 0) cur.push(id); });
      if (cur.length !== n) storageSet(suffix, JSON.stringify(cur.slice(-200)));
    }
    var shareApi = {
      labels: {
        get: function () { return labels; },
        set: function (slotId, text) { return mutateLabels(function (m) { m[slotId] = text; }); },
        drop: function (slotId) { return labels[slotId] === undefined ? Promise.resolve() : mutateLabels(function (m) { delete m[slotId]; }); },
      },
      // Slots that the faculty added in a recovery: the owner confirms the notice once per device; the core refuses roster edits until it is told that the notice is known.
      acked: {
        pending: function (status) {
          var foreign = foreignRecoverySlots(status), done = idList('acked'), fresh = foreign.filter(function (id) { return done.indexOf(id) < 0; });
          if (!fresh.length && foreign.length) client.acknowledgeRecovery();
          return fresh;
        },
        confirm: function (ids) { client.acknowledgeRecovery(); addIds('acked', ids); },
      },
      seen: { add: function (ids) { addIds('seen', ids); } },   // redeemed invitations that the owner has looked at in the roster
      lock: function () { return lockSession('user'); },
      onRevoked: function () { lockSession('revoked'); },
      exportAll: exportAll,
    };

    // ---- after unlock ----
    function noticeDialog(title, build) {
      return new Promise(function (resolve) {
        var dlg = dialogFor(S, { title: title, view: 'notice', cancelable: true, closeLabel: t('common.close'), onClose: function () { resolve(); } });
        dlg.body.appendChild(build(dlg));
        dlg.body.appendChild(el('div', { 'data-wds': 'form-error', 'aria-live': 'polite' }));
        dlg.focusFirst();
      });
    }
    async function afterUnlock(res) {
      var info = S.info, st = client.status();
      if (isSandbox(S)) { S.sandboxWipe = info.sandbox.next_wipe; showSandboxBadge(S); } else S.sandboxWipe = null;
      if (info && info.library && Array.isArray(info.library.deprecated) && info.library.deprecated.indexOf(Core.version) >= 0) notify(t('note.advisory'), 'advisory');
      if (info && info.status === 'suspended') notify(t('note.suspended'), 'suspended');
      else if (info && info.read_only) notify(t('note.readOnly'), 'readonly');
      if (st.role === 'owner') {
        if (st.recovery) {
          await noticeDialog(t('share.recovery.title'), function (dlg) {
            return recoveryRequestNode(S, st.recovery, function () {
              client.cancelRecovery().then(function () { notify(t('share.recovery.cancelled'), 'recovery'); dlg.close(); }, function (e) { reportError(e); dlg.close(); });
            }, function () { dlg.close(); }, true);
          });
        }
        var freshRecovered = shareApi.acked.pending(st);
        if (freshRecovered.length) {
          await noticeDialog(t('share.recovered.title'), function (dlg) {
            return recoveredNode(S, function () { shareApi.acked.confirm(freshRecovered); dlg.close(); }, true);
          });
        }
      }
      try { await client.maintain(); } catch (e) { if (typeof console !== 'undefined') console.warn('wds: maintenance skipped: ' + e.message); }
      st = client.status();
      if (!res.created && !res.redeemed && st.newDevice) notify(t(st.stateStatus === 'invalid' ? 'note.stateInvalid' : 'note.newDevice'), 'newdevice');
      if (st.role === 'owner') {
        var seen = idList('seen');
        var fresh = client.members().filter(function (m) { return m.redeemed && !m.self && seen.indexOf(m.slotId) < 0; });
        if (fresh.length) {
          okNotice(t('note.redeemed.title'), fresh.length === 1 ? t('note.redeemed.one') : t('note.redeemed.other', { n: fresh.length }));
          shareApi.seen.add(fresh.map(function (m) { return m.slotId; }));
        }
        if (st.rekeyPending) runRekey();
      }
      document.documentElement.setAttribute('data-wds-role', st.role);
      installWatcher();
    }
    function runRekey() {
      if (rekeyRunning) return;
      rekeyRunning = true;
      notify(t('note.rekey', { done: 0, left: '…' }), 'rekey');
      client.resumeRekey({ onProgress: function (p) { notify(t('note.rekey', { done: p.rekeyed, left: p.remaining }), 'rekey'); } }).then(function (r) {
        if (r.done) notify(t('note.rekey.done'), 'rekey');
      }, function (e) {
        if (e instanceof Err.AuthError || e instanceof Err.IntegrityError) reportError(e);
        else notify(t('note.rekey.failed'), 'rekey');
      }).then(function () { rekeyRunning = false; });
    }

    // ---- what changed elsewhere (on focus): store.onChange with remote: true ----
    async function checkRemote() {
      if (!client.status().unlocked || checking || reloading || Date.now() - lastCheck < 15000) return;
      checking = true; lastCheck = Date.now();
      try {
        var watched = [];
        collections.forEach(function (c) { if (c._loaded()) watched.push(c._indexName); });
        var rows = (await client.checkRemote({ names: watched })).filter(function (r) { return !isInternalName(r.name) && seenRemote[(r.name || '?') + '@' + r.version] !== true; });
        var names = [], jobs = [];
        rows.forEach(function (r) {
          seenRemote[(r.name || '?') + '@' + r.version] = true;
          var hit = null;
          collections.forEach(function (c) { if (c._indexName === r.name) hit = c; });
          if (hit) jobs.push(hit._refresh().then(function (ns) { names = names.concat(ns); }));   // the index is merged by the library: the item names that differ
          else if (r.name) names.push(r.name);
        });
        await Promise.all(jobs);
        emitChange(names, true);
      } catch (e) { if (e instanceof Err.AuthError) reportError(e); /* the rest of the check is best effort: an offline page tries again on the next focus */ } finally { checking = false; }
    }
    function installWatcher() {
      if (watchInstalled || typeof window === 'undefined') return;
      watchInstalled = true;
      window.addEventListener('focus', checkRemote);
      document.addEventListener('visibilitychange', function () { if (!document.hidden) checkRemote(); });
    }
    function installUnloadGuards() {
      if (unloadInstalled || typeof window === 'undefined') return;
      unloadInstalled = true;
      function flushOnHide() {
        allHandles.forEach(function (a) { if (a._i.dirty()) a.flush(); });
        collections.forEach(function (c) { c._flushNow(); });
      }
      document.addEventListener('visibilitychange', function () { if (document.hidden) flushOnHide(); });
      window.addEventListener('pagehide', flushOnHide);
      window.addEventListener('online', function () { offlineShown = false; retryAll(); });
      window.addEventListener('focus', function () { collections.forEach(function (c) { c._retry(); }); });
      window.addEventListener('beforeunload', function (ev) {
        if (!reloading && unsavedCount() > 0) { ev.preventDefault(); ev.returnValue = ''; }
      });
    }

    return store;
  }

  var api = {
    version: UI_VERSION,
    connect: connect,
    errors: Core.errors,
    // pure helpers and texts; used by the unit tests and tools, not part of the app API
    internals: {
      TEXT: TEXT, makeT: makeT, detectLang: detectLang, estimate: estimate, checkLocal: checkLocal, breachCheck: breachCheck,
      crc32: crc32, makeZip: makeZip, buildArchive: buildArchive, archivePaths: archivePaths, buildSheetHtml: buildSheetHtml, markedName: markedName,
      applyCollectionOps: applyCollectionOps, fileSafe: fileSafe, formatBytes: formatBytes, formatTime: formatTime, MIN_PASSPHRASE: MIN_PASSPHRASE, WORD_COUNT: WORD_COUNT, COMMON_COUNT: COMMON_EXACT.length,
      migrate: { rowId: migrateRowId, keyToken: migrateKeyToken, parse: migrateParse, canonText: canonText, checkJson: migrateCheckJson, MigrateStop: MigrateStop },
      testHooks: TEST_HOOKS,
    },
  };
  return api;
});
})();
