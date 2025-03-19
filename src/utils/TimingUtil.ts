class TimingUtil {

    async waitSeconds(seconds: number): Promise<void> {
        return new Promise((resolve, reject) => {
            setTimeout(() => {
                resolve();
            }, 1000 * seconds);
        });
    }

}

export default new TimingUtil();