#!/bin/bash
# usage: run.sh name  (reads step body from stdin; body is the inside of `export default async H => { ... }`)
D=/tmp/claude-0/-home-user/6b4329cd-b9c4-5120-b7a2-49bfdc721969/scratchpad/round6
N=$1; rm -f $D/out/$N.json
{ echo 'export default async H => { const {p,cdp,st,tapV,tapW,keypad,projW,drag,bar,act,shot,state}=H;'; cat; echo '}'; } > $D/tmp_$N.mjs
mv $D/tmp_$N.mjs $D/steps/$N.mjs
for i in $(seq 1 2900); do [ -f $D/out/$N.json ] && { cat $D/out/$N.json; exit 0; }; sleep 0.2; done; echo TIMEOUT
