# POTA ADIF Prep

Simple single-page site to take an ADI (.adi) file and a Park Reference, then inject a `POTA_REF` field in the ADIF header and each QSO record so the output is ready for upload to https://pota.app.

Quick start (with Docker):

```bash
# build image (run from the project folder containing this README)
docker build -t pota-adi-uploader .

# run container and open http://localhost:8080
docker run --rm -p 8080:80 pota-adi-uploader
```

Usage:
- Open the site in your browser.
- Choose your `.adi` file.
- Enter the Park Reference (for example `K-1234`).
- Click `Process ADI` then `Download ADI` to save the transformed file.

Notes:
- This tool parses ADIF in a tolerant way and injects a `POTA_REF` tag in the header (if missing) and into every QSO record.
- It aims to create ADIF suitable for POTA.app upload, but you should inspect the resulting file in the preview before submitting.
