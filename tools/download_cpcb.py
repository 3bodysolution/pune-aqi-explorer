"""Download the CPCB Pune station CSVs (2017-2025) published on data.opencity.in into raw/.

Usage:  python tools/download_cpcb.py raw
Dataset: https://data.opencity.in/dataset/pune-hourly-air-quality-reports (Public Domain)
"""
import os, sys, urllib.request

RAW = sys.argv[1]
B = 'https://data.opencity.in/dataset/b16b4972-1d7e-4b7e-b1d6-23228cc63c83/resource/'
FILES = {
    'h_alandi': '38290549-5b3d-4778-a916-029c70d88254/download/a9407013-dba4-48fe-afda-bb951f4f3cfe.csv',
    'h_bhosari': '15d82ada-9e8f-474c-93b7-f0f616295bad/download/6c9be432-4a82-4661-972f-e4ac9be0d252.csv',
    'h_hadapsar': 'c5659bc4-bbcf-4a35-84b9-4f5e8270c8f5/download/5ec1c512-c3f1-4ef6-81eb-4a5147241377.csv',
    'h_karve': 'a00761c0-a1a7-4513-b58b-2f940b8b64ff/download/f421cdb4-57de-42ad-bd16-0bfd54e79cae.csv',
    'h_katraj': '2eb9d843-b66f-4bf2-8080-7b7b9ea445e8/download/bce229f1-23a9-4805-acd0-e21a6c72691b.csv',
    'h_mhada': '34d740b6-8912-4df8-907d-d782e1f0aafa/download/697e0d85-930c-4990-972f-1ad9eac2db05.csv',
    'h_kothrud': '98aad25d-5975-4afc-8c01-e96abb2ce9bc/download/7ac0c4c7-01a3-4311-8617-41a0b1cf03d9.csv',
    'h_shivajinagar': 'cccbaca5-350c-4725-8a80-a4431c71caf6/download/fbf99e33-887b-4a97-8861-fe44d24cb48a.csv',
    'h_sppu': '38a40ce7-ef14-48c0-8855-352470c763f6/download/932cbc17-1ef0-4c1c-ada6-fa63221b4459.csv',
    'h_nigdi': '64cfe8b6-edff-446a-8083-d27fa5b9269f/download/3db44ac9-ef90-41c4-b915-ff751de81679.csv',
    'q_alandi': '70f9292d-f5ab-4b7d-8220-481b3e8c4ace/download/pune-alandi-iitm-2024-25.csv',
    'q_bhosari': 'c6bdd375-eacc-4584-bc64-82d139fd344f/download/pune-bhosari-iitm-2024-25.csv',
    'q_bhumkar': '7cc44628-08e5-40d3-b323-4e6246f5d868/download/pune-bhumkar-nagar-iitm-2024-25.csv',
    'q_dhankawadi': 'd62efc0d-c847-4c24-a5aa-a4dd2cf8b925/download/pune-dhankawadi-iitm-2025.csv',
    'q_hadapsar': '59a536da-dd4d-4597-b84e-bcfc85fa2fca/download/pune-hadapsar-iitm-2024-25.csv',
    'q_karve': '42ae24da-8bd1-46ce-8acb-df2b3b5aa677/download/pune-karve-road-mpcb-2024-25.csv',
    'q_katraj': 'f427afcc-4e7d-4092-81ac-cd823584b325/download/pune-katraj-dairy-mpcb-2024-25.csv',
    'q_mhada': '938b7b23-63b7-479b-a7aa-2afc32c1ad09/download/pune-mhada-colony-iitm-2024-25.csv',
    'q_pashan': 'da12ee9d-21bf-4f5d-98d4-052b3a85c216/download/pune-panchawati_pashan-iitm-2024-25.csv',
    'q_shivajinagar': 'de7ed9dd-5be3-4e9d-b142-85a85f4d910d/download/pune-revenue-colony-shivajinagar-iitm-2024-25.csv',
    'q_sppu': 'bcd8e8ae-d0f7-466f-a502-913e4bca220b/download/pune-savitribai-phule-pune-university-mpcb-2024-25.csv',
    'q_nigdi': '0aaa077d-2dfd-4b22-9fad-485357f075a8/download/pune-transport-nagar-nigdi-iitm-2024-25.csv',
}
os.makedirs(RAW, exist_ok=True)
for name, path in FILES.items():
    out = os.path.join(RAW, name + '.csv')
    if os.path.exists(out) and os.path.getsize(out) > 0: continue
    req = urllib.request.Request(B + path, headers={'User-Agent': 'pune-aqi-explorer'})
    with urllib.request.urlopen(req, timeout=300) as r, open(out + '.part', 'wb') as f: f.write(r.read())
    os.replace(out + '.part', out)
    print('downloaded', name)
