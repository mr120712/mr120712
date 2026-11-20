#!/usr/bin/env python3
"""
Genera la TG_SESSION_STRING per il deploy headless (Fly/Docker), così non devi caricare il file
`.session`. Eseguilo UNA volta sul TUO computer: fa il login interattivo (numero + codice + 2FA) e
stampa la stringa di sessione.

    TG_API_ID=123456 TG_API_HASH=xxxx python3 bootstrap_session.py

La stringa è un SEGRETO (contiene la auth key): non condividerla, non committarla. Impostala come
secret del deploy, es:  fly secrets set TG_SESSION_STRING="...".
"""
import os

from telethon.sessions import StringSession
from telethon.sync import TelegramClient

api_id = int(os.environ["TG_API_ID"])
api_hash = os.environ["TG_API_HASH"]

with TelegramClient(StringSession(), api_id, api_hash) as client:
    me = client.get_me()
    print(f"\nLogin riuscito come @{me.username or me.id}.")
    print("\n=== TG_SESSION_STRING (SEGRETO — non condividere) ===")
    print(client.session.save())
    print("=== fine ===")
    print('\nImpostala come secret, es:  fly secrets set TG_SESSION_STRING="...incolla qui..."')
