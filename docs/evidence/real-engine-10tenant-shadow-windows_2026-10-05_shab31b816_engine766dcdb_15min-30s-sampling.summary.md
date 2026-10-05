# 10 real aria-engine tenants, shadow mode, Windows 11 (summary of the sibling .json)

Offline stub RPC at 127.0.0.1 (no external endpoint), shadow start, NOT paper mode, NOT Linux.
Engine 766dcdbc7aca1dad54d6294729fba1f45a8b6481, control plane b31b816 (includes d5ddbb3).
Tenant = process tree (node + tsx child, 2 procs). 30 samples at 30s over ~15.5 min.
Tenant cap-tenant-3 was SIGKILLed at ~450s (its min values reflect the restart; per-tenant CPU for it is not comparable).

| series | min | median | max | first-third median -> last-third median |
|---|---|---|---|---|
| control plane RSS KB (process.memoryUsage) | 77,324 | 81,106 | 86,048 | 79,076 -> 81,648 (+3.3%) |
| control plane working set KB (Win32) | 77,196 | 81,074 | 86,048 | 79,066 -> 81,648 (+3.3%) |
| control plane private KB | 80,620 | 83,478 | 93,224 | 81,726 -> 84,168 (+3.0%) |
| per-tenant working set KB, all 10 tenants pooled | 72,920 | 112,936 | 119,020 | 113,174 -> 113,504 (+0.3%) |
| per-tenant private bytes KB, all 10 pooled | 70,472 | 153,478 | 174,324 | 153,842 -> 153,932 (+0.1%) |

| tenant | WS min/med/max KB | private min/med/max KB | procs | CPU s total | CPU % of 1 core |
|---|---|---|---|---|---|
| cap-tenant-0 | 106,048/113,914/118,048 | 146,664/154,292/170,544 | 2 | 5.5 | 0.59% |
| cap-tenant-1 | 105,312/112,900/118,468 | 146,440/154,018/171,904 | 2 | 4.5 | 0.49% |
| cap-tenant-2 | 105,688/113,456/118,096 | 147,016/154,088/171,232 | 2 | 5.4 | 0.58% |
| cap-tenant-3 | 72,920/93,282/118,436 | 70,472/112,522/170,696 | 2 | 1.8 | 0.20% |
| cap-tenant-4 | 105,856/112,962/117,724 | 146,792/153,298/171,344 | 2 | 5.1 | 0.55% |
| cap-tenant-5 | 105,480/112,970/117,928 | 146,204/153,188/171,576 | 2 | 4.8 | 0.51% |
| cap-tenant-6 | 105,680/113,076/118,652 | 146,956/153,904/174,324 | 2 | 5.5 | 0.59% |
| cap-tenant-7 | 106,208/113,260/119,020 | 147,096/153,826/171,112 | 2 | 5.3 | 0.57% |
| cap-tenant-8 | 105,760/113,290/118,804 | 146,924/153,700/173,400 | 2 | 4.7 | 0.51% |
| cap-tenant-9 | 105,720/113,332/118,444 | 146,224/153,326/171,964 | 2 | 5.5 | 0.59% |
