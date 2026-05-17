#!/bin/sh

ffmpeg \
  -f s16le -ar 16000 -i recordings/call_${1}_received.raw \
  -f s16le -ar 24000 -i recordings/call_${1}_sent.raw \
  -filter_complex "[0:a][1:a]amix=inputs=2:duration=longest" \
  -f s16le -ar 24000 pipe:1 | \
ffplay -f s16le -ar 24000 -nodisp -autoexit -i pipe:0
