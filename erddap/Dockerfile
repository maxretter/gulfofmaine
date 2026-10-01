# ERDDAP serving the products (heatwaves/products.py) from the products volume, as NERACOOS's would.
FROM axiom/docker-erddap:v2.31.1
COPY datasets.xml /usr/local/tomcat/content/erddap/datasets.xml
# The JVM's heap, at start and at most (the image's bin/setenv.sh). The image's
# 4G is sized for a big ERDDAP; these two datasets are about 26 files of 1 MB.
# Override ERDDAP_MEMORY, not ERDDAP_MAX_MEMORY: that alone, under 4G, leaves
# the start above the cap, and Java won't start.
ENV ERDDAP_MEMORY=1G
