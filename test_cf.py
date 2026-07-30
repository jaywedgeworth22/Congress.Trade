import requests
import json

headers = {
    'Authorization': 'Bearer cfat_GjVoUgG9DZokdeD3eGtfLBgBPKv4AQkhGcA69i2w65f106f3',
    'Content-Type': 'application/json'
}

response = requests.get('https://api.cloudflare.com/client/v4/zones/bd20e165b0e38bdd54237dc398c4740e/dns_records', headers=headers)
print(response.status_code)
print(response.json())
