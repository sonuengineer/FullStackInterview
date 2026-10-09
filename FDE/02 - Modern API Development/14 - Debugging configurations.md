# Modern API Development

## Debugging configurations

> Extended (slow track only) | Slow CP2 only | ~1.2 h

`print()` debugging customer site pe jaldi khatam ho jaata hai -- breakpoints, variable inspection aur step-through chahiye. VS Code mein ye `.vscode/launch.json` ki debug configurations se hota hai (Python Debugger extension, andar `debugpy`).
Teen configs jo har FDE repo mein rakho: (1) **FastAPI app** -- `"module": "uvicorn"`, `"args": ["app.main:app", "--reload"]`, `"envFile": "${workspaceFolder}/.env"`; (2) **current pytest file** -- `"module": "pytest"`, `"args": ["${file}", "-x"]` (pytest-cov breakpoints ke saath clash kare to `--no-cov` add karo); (3) **attach** -- container ke andar `python -m debugpy --listen 0.0.0.0:5678 -m uvicorn ...` aur VS Code se attach (M04 mein Docker ke saath).
Terminal se: code mein `breakpoint()` likho (pdb khulta hai), ya `pytest --pdb` -- failure pe seedha debugger. `"justMyCode": false` se FastAPI/SQLAlchemy ke andar bhi step kar sakte ho.
FDE angle: `.env` mein customer ke secrets hote hain -- `launch.json` commit karo, `.env` kabhi nahi; aur debug port sirf localhost ya SSH tunnel pe expose karo, kabhi public internet pe nahi (debugpy = remote code execution).

**Try this (20-40 min):** `omniguard/.vscode/launch.json` mein upar ke teen configs banao; `get_current_user` (M02-03) mein breakpoint lagao, `/documents` hit karo aur headers inspect karo; phir ek failing test pe `pytest --pdb` chala ke `p r.json()` try karo.

**Read:** https://code.visualstudio.com/docs/python/debugging
